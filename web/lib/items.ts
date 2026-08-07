import type { Item, StoredEvent } from './types'

/**
 * Pliega el log de eventos en tarjetas: los `tool_result` se pegan a su
 * `tool_use` y las respuestas de permiso marcan la tarjeta original, para que
 * la lista no crezca con ruido en una pantalla de 6 pulgadas.
 */
export function buildItems(events: StoredEvent[]): Item[] {
  const items: Item[] = []
  const toolIndex = new Map<string, number>()
  const permissionIndex = new Map<string, number>()
  /** Dónde empezó el turno en curso, para saber qué archivos dejó. */
  let turnStart = 0

  for (const event of events) {
    const key = String(event.seq)
    switch (event.kind) {
      case 'user':
        items.push({ type: 'user', key, ts: event.ts, text: event.text })
        break

      case 'assistant':
        items.push({ type: 'assistant', key, ts: event.ts, text: event.text })
        break

      case 'thinking': {
        const last = items[items.length - 1]
        if (last?.type === 'thinking') break // no repetir el indicador
        items.push({ type: 'thinking', key, ts: event.ts })
        break
      }

      case 'tool_use':
        toolIndex.set(event.toolUseId, items.length)
        items.push({
          type: 'tool',
          key,
          ts: event.ts,
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
          result: null,
          isError: false,
        })
        break

      case 'tool_result': {
        const idx = toolIndex.get(event.toolUseId)
        if (idx === undefined) break
        const target = items[idx]
        if (target?.type !== 'tool') break
        items[idx] = { ...target, result: event.text, isError: event.isError }
        break
      }

      case 'permission':
        permissionIndex.set(event.request.id, items.length)
        items.push({ type: 'permission', key, ts: event.ts, request: event.request, decision: null })
        break

      case 'permission_resolved': {
        const idx = permissionIndex.get(event.id)
        if (idx === undefined) break
        const target = items[idx]
        if (target?.type !== 'permission') break
        items[idx] = { ...target, decision: event.decision }
        break
      }

      case 'result': {
        // Los archivos que dejó el turno se cuelgan de su cierre, que es donde
        // el usuario mira al terminar. Se leen de las tarjetas ya plegadas, así
        // que un `Write` que falló no cuenta: su `tool_result` ya lo marcó.
        const produced: string[] = []
        for (const item of items.slice(turnStart)) {
          if (item.type !== 'tool' || item.isError) continue
          const path = toolFilePath(item.name, item.input)
          if (path && toolFlow(item.name) === 'salida' && !produced.includes(path)) produced.push(path)
        }
        items.push({
          type: 'result',
          key,
          ts: event.ts,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          isError: event.isError,
          produced,
        })
        turnStart = items.length
        break
      }

      case 'compacted':
        items.push({ type: 'compacted', key, ts: event.ts, preTokens: event.preTokens })
        break

      case 'notice':
        items.push({ type: 'notice', key, ts: event.ts, text: event.text, tone: 'info' })
        break

      case 'error':
        items.push({ type: 'notice', key, ts: event.ts, text: event.message, tone: 'error' })
        break

      default:
        break
    }
  }

  return items
}

/** Herramientas que escriben archivos: lo que salga de ellas es una salida. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Herramientas que solo miran. */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])

export type ToolFlow = 'entrada' | 'salida' | null

export function toolFlow(name: string): ToolFlow {
  if (WRITE_TOOLS.has(name)) return 'salida'
  if (READ_TOOLS.has(name)) return 'entrada'
  // `Bash` puede hacer cualquier cosa: etiquetarlo sería mentir.
  return null
}

/** Ruta del archivo que toca una herramienta, si toca alguno. */
export function toolFilePath(name: string, input: Record<string, unknown>): string | null {
  if (!WRITE_TOOLS.has(name) && name !== 'Read') return null
  const raw = input.file_path ?? input.notebook_path
  return typeof raw === 'string' && raw ? raw : null
}

/** Resumen de una línea para la cabecera de la tarjeta de herramienta. */
export function summarizeTool(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : null)
  switch (name) {
    case 'Bash':
      return str('command') ?? ''
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return shortPath(str('file_path') ?? '')
    case 'Glob':
      return str('pattern') ?? ''
    case 'Grep':
      return `${str('pattern') ?? ''}${str('path') ? ` en ${shortPath(str('path')!)}` : ''}`
    case 'WebFetch':
      return str('url') ?? ''
    case 'WebSearch':
      return str('query') ?? ''
    case 'Task':
    case 'Agent':
      return str('description') ?? ''
    case 'TodoWrite':
      return 'lista de tareas'
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined
      return first ?? ''
    }
  }
}

export function shortPath(path: string): string {
  if (!path) return ''
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

const STATUS_LABEL: Record<string, string> = {
  dormant: 'Dormida',
  starting: 'Arrancando',
  idle: 'Lista',
  busy: 'Trabajando',
  awaiting_permission: 'Espera permiso',
  error: 'Error',
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status
}

export function formatCost(usd: number): string {
  if (!usd) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return `${min} min ${sec} s`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function relativeTime(ts: number | null): string {
  if (!ts) return 'nunca'
  const diff = Date.now() - ts
  if (diff < 60_000) return 'ahora'
  if (diff < 3_600_000) return `hace ${Math.floor(diff / 60_000)} min`
  if (diff < 86_400_000) return `hace ${Math.floor(diff / 3_600_000)} h`
  return `hace ${Math.floor(diff / 86_400_000)} d`
}
