import type { KnowledgeEntry, StoredEvent } from './types'

/** Herramientas que tocan archivos, y qué significa cada una para el listado. */
const FILE_TOOLS: Record<string, 'creado' | 'editado' | 'leído'> = {
  Write: 'creado',
  Edit: 'editado',
  MultiEdit: 'editado',
  NotebookEdit: 'editado',
  Read: 'leído',
}

export type TouchedFile = {
  /** Ruta relativa al cwd de la sesión cuando se puede; si no, la absoluta. */
  path: string
  name: string
  action: 'subido' | 'creado' | 'editado' | 'leído'
  /** Última vez que la sesión lo tocó. */
  seq: number
  ts: number
  times: number
  failed: boolean
}

/**
 * Archivos que ha tocado la sesión, derivados del propio log de eventos.
 * Para lo que hace el agente basta con `tool_use`, y el `tool_result`
 * correspondiente indica si la operación falló. Lo que sube el usuario no pasa
 * por ninguna herramienta, así que va en su propio evento.
 */
export function touchedFiles(events: StoredEvent[], cwd: string): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>()
  const pendingByToolUse = new Map<string, string>()

  for (const event of events) {
    if (event.kind === 'attachment') {
      for (const raw of event.paths) {
        const path = relativize(raw, cwd)
        const existing = byPath.get(path)
        byPath.set(path, {
          path,
          name: path.split('/').pop() ?? path,
          action: 'subido',
          seq: event.seq,
          ts: event.ts,
          times: (existing?.times ?? 0) + 1,
          failed: false,
        })
      }
      continue
    }

    if (event.kind === 'tool_use') {
      const action = FILE_TOOLS[event.name]
      if (!action) continue
      const raw = typeof event.input.file_path === 'string' ? event.input.file_path : null
      if (!raw) continue

      const path = relativize(raw, cwd)
      const existing = byPath.get(path)
      // Crear pesa más que editar, y editar más que leer: el listado debe
      // decir qué pasó con el archivo, no cuál fue la última operación.
      const action2 = existing ? strongest(existing.action, action) : action
      byPath.set(path, {
        path,
        name: path.split('/').pop() ?? path,
        action: action2,
        seq: event.seq,
        ts: event.ts,
        times: (existing?.times ?? 0) + 1,
        failed: existing?.failed ?? false,
      })
      pendingByToolUse.set(event.toolUseId, path)
      continue
    }

    if (event.kind === 'tool_result') {
      const path = pendingByToolUse.get(event.toolUseId)
      if (!path) continue
      pendingByToolUse.delete(event.toolUseId)
      const entry = byPath.get(path)
      if (entry && event.isError) byPath.set(path, { ...entry, failed: true })
    }
  }

  return [...byPath.values()].sort((a, b) => b.seq - a.seq)
}

/**
 * `subido` pesa más que todo: que el agente después lo lea o lo edite no
 * cambia de dónde salió el archivo, y de dónde salió es lo que interesa saber.
 */
const WEIGHT = { leído: 0, editado: 1, creado: 2, subido: 3 } as const

function strongest(a: TouchedFile['action'], b: TouchedFile['action']): TouchedFile['action'] {
  return WEIGHT[a] >= WEIGHT[b] ? a : b
}

/** Deja la ruta relativa al cwd cuando cae dentro; si no, la devuelve tal cual. */
export function relativize(path: string, cwd: string): string {
  if (!cwd) return path
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

// ------------------------------------------------------------------ preguntas

export type PastQuestion = { seq: number; ts: number; text: string }

export function pastQuestions(events: StoredEvent[]): PastQuestion[] {
  return events
    .filter((e): e is StoredEvent & { kind: 'user'; text: string } => e.kind === 'user')
    .map((e) => ({ seq: e.seq, ts: e.ts, text: e.text }))
    .reverse()
}

// ------------------------------------------------------------- línea de tiempo

export type TimelineItem =
  | { type: 'knowledge'; ts: number; seq: number; entry: KnowledgeEntry }
  | { type: 'turn'; ts: number; seq: number; question: string; costUsd: number; durationMs: number }
  | { type: 'compacted'; ts: number; seq: number; preTokens: number }
  | { type: 'denied'; ts: number; seq: number; text: string }

/**
 * La línea de tiempo mezcla dos fuentes: los hitos de la conversación y las
 * entradas de knowledge que esa misma conversación fue generando. Es lo que
 * convierte un chat largo en algo que se puede recorrer.
 */
export function buildTimeline(
  events: StoredEvent[],
  knowledge: KnowledgeEntry[],
  sessionId: string,
): TimelineItem[] {
  const items: TimelineItem[] = []

  // Un turno = la pregunta y el `result` que la cierra.
  let openQuestion: { seq: number; text: string } | null = null
  for (const event of events) {
    if (event.kind === 'user') {
      openQuestion = { seq: event.seq, text: event.text }
    } else if (event.kind === 'result' && openQuestion) {
      items.push({
        type: 'turn',
        ts: event.ts,
        seq: openQuestion.seq,
        question: openQuestion.text,
        costUsd: event.costUsd,
        durationMs: event.durationMs,
      })
      openQuestion = null
    } else if (event.kind === 'compacted') {
      items.push({ type: 'compacted', ts: event.ts, seq: event.seq, preTokens: event.preTokens })
    } else if (event.kind === 'permission_resolved' && event.decision === 'deny') {
      items.push({ type: 'denied', ts: event.ts, seq: event.seq, text: event.message ?? 'Permiso rechazado' })
    }
  }

  for (const entry of knowledge) {
    if (entry.sessionId !== sessionId) continue
    items.push({ type: 'knowledge', ts: entry.ts, seq: 0, entry })
  }

  return items.sort((a, b) => b.ts - a.ts)
}

export function groupByDay<T extends { ts: number }>(items: T[]): { date: string; items: T[] }[] {
  const buckets = new Map<string, T[]>()
  for (const item of items) {
    const d = new Date(item.ts)
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    buckets.set(key, [...(buckets.get(key) ?? []), item])
  }
  return [...buckets.entries()].map(([date, list]) => ({ date, items: list })).sort((a, b) => b.date.localeCompare(a.date))
}

const pad = (n: number) => String(n).padStart(2, '0')

export function formatDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const parsed = new Date(y, m - 1, d)
  const today = new Date()
  if (parsed.toDateString() === today.toDateString()) return 'Hoy'
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (parsed.toDateString() === yesterday.toDateString()) return 'Ayer'
  return parsed.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' })
}

export function shortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
}
