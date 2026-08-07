import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { config } from './config.js'
import { confinementHook } from './confinement.js'
import { AsyncQueue } from './queue.js'
import { appendEvent, readEvents } from './store.js'
import type {
  ModelRoles,
  PermissionRequestView,
  SessionEvent,
  SessionMeta,
  SessionStatus,
  SessionView,
  StoredEvent,
} from './types.js'

type PendingPermission = {
  view: PermissionRequestView
  resolve: (result: PermissionResult) => void
  suggestions: PermissionUpdate[]
}

export type SessionHooks = {
  onEvent: (session: ClaudeSession, event: StoredEvent) => void
  onMetaChange: (session: ClaudeSession) => void
  onResult: (
    session: ClaudeSession,
    result: { costUsd: number; durationMs: number; numTurns: number; model: string },
  ) => void
  /** La sesión terminó un turno y volvió a estar libre: momento de volcar knowledge. */
  onIdle: (session: ClaudeSession) => void
  /** Modelos por rol del proyecto al que pertenece la sesión. */
  modelsFor: (session: ClaudeSession) => ModelRoles | null
  /**
   * Evalúa un permiso contra las reglas del proyecto antes de molestar al
   * humano. Devuelve null si la auto-aprobación está apagada.
   */
  evaluatePermission: (
    session: ClaudeSession,
    request: { toolName: string; input: Record<string, unknown>; title: string },
  ) => Promise<{ decision: 'allow' | 'deny' | 'ask'; reason: string } | null>
}

/**
 * Una sesión = un `query()` en modo streaming input que se mantiene abierto.
 *
 *   dormant --wake()--> starting --> idle <--> busy / awaiting_permission
 *   dormant <--hibernate()/stop()--
 *
 * Al hibernar se cierra la cola de input: el proceso del CLI termina pero el
 * `sdkSessionId` queda guardado, así que el siguiente mensaje reanuda la
 * conversación completa con `resume`. Desde el celular no se nota.
 */
export class ClaudeSession {
  meta: SessionMeta
  status: SessionStatus = 'dormant'
  seq = 0

  private hooks: SessionHooks
  private queue: AsyncQueue<SDKUserMessage> | null = null
  private handle: Query | null = null
  private runPromise: Promise<void> | null = null
  private pending = new Map<string, PendingPermission>()
  private recent: StoredEvent[] = []
  private idleTimer: NodeJS.Timeout | null = null
  private stopping = false

  constructor(meta: SessionMeta, hooks: SessionHooks, seq = 0) {
    this.meta = meta
    this.hooks = hooks
    this.seq = seq
  }

  // ---------------------------------------------------------------- lectura

  toView(): SessionView {
    const lastText = [...this.recent].reverse().find((e) => e.kind === 'assistant' || e.kind === 'user')
    return {
      ...this.meta,
      status: this.status,
      seq: this.seq,
      pendingPermissions: [...this.pending.values()].map((p) => p.view),
      preview:
        lastText && (lastText.kind === 'assistant' || lastText.kind === 'user')
          ? lastText.text.slice(0, 160)
          : null,
    }
  }

  recentEvents(since: number): StoredEvent[] {
    return this.recent.filter((e) => e.seq > since)
  }

  /**
   * Eventos posteriores a `since`. Se sirven de memoria cuando el búfer los
   * cubre; si el cliente pide algo más viejo se lee del JSONL.
   */
  async history(since: number, limit = 400): Promise<StoredEvent[]> {
    const oldestInMemory = this.recent[0]?.seq
    if (oldestInMemory !== undefined && since >= oldestInMemory - 1) {
      return this.recentEvents(since).slice(-limit)
    }
    return readEvents(this.meta.id, since, limit)
  }

  // ---------------------------------------------------------------- escritura

  private emit(event: SessionEvent) {
    const stored: StoredEvent = { ...event, seq: ++this.seq, ts: Date.now() }
    this.recent.push(stored)
    if (this.recent.length > config.memoryEventCap) {
      this.recent.splice(0, this.recent.length - config.memoryEventCap)
    }
    appendEvent(this.meta.id, stored)
    this.hooks.onEvent(this, stored)
  }

  private setStatus(status: SessionStatus) {
    if (this.status === status) return
    this.status = status
    this.emit({ kind: 'status', status })
    this.touchMeta()
  }

  private touchMeta() {
    this.meta.updatedAt = Date.now()
    this.hooks.onMetaChange(this)
  }

  // ---------------------------------------------------------------- control

  get isLive() {
    return this.handle !== null
  }

  /**
   * Deja constancia de archivos de entrada sin enviar nada.
   *
   * Lo usa el arranque de un proyecto, donde el prompt ya viene compuesto y
   * solo falta que el panel lateral sepa que esos archivos los puso el usuario.
   */
  noteAttachments(paths: string[]) {
    if (paths.length) this.emit({ kind: 'attachment', paths })
  }

  async send(text: string, attachments: string[] = []) {
    this.noteAttachments(attachments)
    // El agente no recibe los bytes: recibe la ruta. Se le nombran delante del
    // mensaje para que sepa que están ahí y pueda abrirlos.
    const prompt = attachments.length
      ? [
          attachments.length === 1 ? 'Archivo que acabo de subir al proyecto:' : 'Archivos que acabo de subir al proyecto:',
          ...attachments.map((path) => `- ${path}`),
          ...(text.trim() ? ['', text] : []),
        ].join('\n')
      : text

    this.emit({ kind: 'user', text: prompt })
    this.meta.lastMessageAt = Date.now()
    this.touchMeta()
    if (!this.isLive) await this.wake()
    this.queue?.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: this.meta.sdkSessionId ?? undefined,
    })
    this.armIdleTimer()
  }

  async interrupt() {
    if (!this.handle) return
    try {
      await this.handle.interrupt()
      this.emit({ kind: 'notice', text: 'Interrumpido desde el celular.' })
    } catch (err) {
      this.emit({ kind: 'error', message: `No se pudo interrumpir: ${errText(err)}` })
    }
  }

  async setPermissionMode(mode: SessionMeta['permissionMode']) {
    const previous = this.meta.permissionMode
    if (mode === previous) return
    this.meta.permissionMode = mode
    this.touchMeta()

    if (this.handle) {
      // El CLI decide `bypassPermissions` al arrancar y rechaza entrar o salir
      // de ese modo en caliente ("la sesión no se creó con ese modo"). Se
      // reinicia el proceso: reanuda por `resume`, así que la conversación
      // sigue intacta y el modo sí queda aplicado de verdad.
      if (mode === 'bypassPermissions' || previous === 'bypassPermissions') {
        await this.restartWithCurrentMode()
      } else {
        try {
          await this.handle.setPermissionMode(mode)
        } catch {
          // Si el CLI lo rechaza igual, reiniciar es preferible a dejar la
          // sesión diciendo un modo y comportándose como otro.
          await this.restartWithCurrentMode()
        }
      }
    }
    // Planificar y ejecutar pueden querer modelos distintos: se cambia al
    // entrar en modo plan y se restaura al salir.
    const planModel = this.hooks.modelsFor(this)?.plan
    if (planModel && mode !== previous && (mode === 'plan' || previous === 'plan')) {
      const target = mode === 'plan' ? planModel : this.meta.model
      if (this.handle) {
        try {
          await this.handle.setModel(target)
          this.emit({ kind: 'notice', text: `Modelo cambiado a ${target} (modo ${mode === 'plan' ? 'plan' : 'normal'}).` })
        } catch (err) {
          this.emit({ kind: 'error', message: `No se pudo cambiar el modelo: ${errText(err)}` })
        }
      }
    }
  }

  /**
   * Recrea el proceso para que arranque con el modo que ya está en `meta`.
   *
   * Es el mismo ciclo de hibernar y despertar que se usa al liberar capacidad,
   * así que la conversación se reanuda con `resume` y no se pierde nada.
   */
  private async restartWithCurrentMode() {
    const mode = this.meta.permissionMode
    try {
      await this.hibernate()
      await this.wake()
      this.emit({
        kind: 'notice',
        text: `Modo de permisos "${mode}": la sesión se reinició para aplicarlo. La conversación sigue.`,
      })
    } catch (err) {
      this.emit({ kind: 'error', message: `No se pudo aplicar el modo ${mode}: ${errText(err)}` })
    }
  }

  async setModel(model: string) {
    this.meta.model = model
    this.touchMeta()
    if (this.handle) {
      try {
        await this.handle.setModel(model)
      } catch (err) {
        this.emit({ kind: 'error', message: `No se pudo cambiar el modelo: ${errText(err)}` })
      }
    }
  }

  resolvePermission(id: string, decision: 'allow' | 'allow_always' | 'deny', message?: string): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    if (decision === 'deny') {
      entry.resolve({ behavior: 'deny', message: message || 'Rechazado desde el celular.' })
    } else {
      entry.resolve({
        behavior: 'allow',
        ...(decision === 'allow_always' && entry.suggestions.length
          ? { updatedPermissions: entry.suggestions }
          : {}),
      })
    }
    this.emit({ kind: 'permission_resolved', id, decision, message })
    if (this.pending.size === 0 && this.status === 'awaiting_permission') this.setStatus('busy')
    return true
  }

  /** Cierra el proceso pero conserva el historial: el próximo mensaje reanuda. */
  async hibernate() {
    if (!this.isLive) return
    this.stopping = true
    this.denyAllPending('Sesión hibernada antes de responder.')
    this.queue?.close()
    try {
      await this.runPromise
    } catch {
      /* el bucle ya reporta sus errores */
    }
    this.stopping = false
  }

  async destroy() {
    this.clearIdleTimer()
    this.denyAllPending('Sesión eliminada.')
    this.queue?.close()
    try {
      this.handle?.close()
    } catch {
      /* ya cerrado */
    }
    this.handle = null
  }

  // ---------------------------------------------------------------- interno

  private denyAllPending(reason: string) {
    for (const [id, entry] of this.pending) {
      entry.resolve({ behavior: 'deny', message: reason })
      this.emit({ kind: 'permission_resolved', id, decision: 'deny', message: reason })
    }
    this.pending.clear()
  }

  private clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private armIdleTimer() {
    this.clearIdleTimer()
    if (!config.idleHibernateMs) return
    this.idleTimer = setTimeout(() => {
      if (this.status === 'idle') void this.hibernate()
    }, config.idleHibernateMs)
  }

  /** Levanta el proceso del CLI, reanudando la conversación previa si existe. */
  async wake(): Promise<void> {
    if (this.isLive) return
    this.setStatus('starting')

    const queue = new AsyncQueue<SDKUserMessage>()
    this.queue = queue

    const options: Options = {
      cwd: this.meta.cwd,
      model: this.meta.model,
      permissionMode: this.meta.permissionMode,
      // Sin esto el agente adivina su ubicación y gasta un turno chocando
      // contra el confinamiento. Decírselo de entrada lo convierte en una
      // restricción que respeta en vez de una que descubre a golpes.
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: [
          `Tu directorio de trabajo es ${this.meta.cwd} y es el único al que tienes acceso.`,
          'Cualquier operación sobre una ruta fuera de él se bloquea antes de ejecutarse,',
          'incluso en modo bypassPermissions. Usa siempre rutas relativas al directorio',
          'de trabajo; no construyas rutas absolutas hacia el home ni hacia carpetas hermanas.',
        ].join(' '),
      },
      includePartialMessages: true,
      // Carga los settings del usuario (CLAUDE.md del proyecto, permisos, MCP)
      // igual que en la terminal.
      settingSources: ['user', 'project', 'local'],
      canUseTool: (toolName, input, opts) => this.handlePermission(toolName, input, opts),
      // Confinamiento duro a la carpeta del proyecto. Va en un hook y no en
      // `canUseTool` porque este último no se invoca en `bypassPermissions`.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              confinementHook(this.meta.cwd, (reason, toolName) => {
                this.emit({ kind: 'notice', text: `Bloqueado ${toolName}: ${reason}.` })
              }),
            ],
          },
        ],
      },
      stderr: (data) => {
        const line = data.trim()
        if (line) console.error(`[${this.meta.id}] ${line}`)
      },
      ...(this.meta.sdkSessionId ? { resume: this.meta.sdkSessionId } : {}),
    }

    const handle = query({ prompt: queue, options })
    this.handle = handle
    this.runPromise = this.consume(handle).finally(() => {
      this.handle = null
      this.queue = null
      this.runPromise = null
      this.clearIdleTimer()
      if (this.status !== 'error') this.setStatus('dormant')
    })
  }

  private async consume(handle: Query) {
    try {
      for await (const message of handle) {
        this.ingest(message)
      }
    } catch (err) {
      if (!this.stopping) {
        this.emit({ kind: 'error', message: errText(err) })
        this.setStatus('error')
      }
    }
  }

  private ingest(message: SDKMessage) {
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          this.meta.sdkSessionId = message.session_id
          this.touchMeta()
          this.setStatus('idle')
        } else if (message.subtype === 'compact_boundary') {
          this.emit({ kind: 'compacted', preTokens: message.compact_metadata.pre_tokens })
        }
        return
      }

      case 'stream_event': {
        const ev = message.event
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text) {
          if (this.status === 'idle') this.setStatus('busy')
          this.emit({ kind: 'delta', text: ev.delta.text })
        }
        return
      }

      case 'assistant': {
        if (this.status === 'idle' || this.status === 'starting') this.setStatus('busy')
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            this.emit({ kind: 'assistant', text: block.text })
          } else if (block.type === 'thinking') {
            this.emit({ kind: 'thinking' })
          } else if (block.type === 'tool_use') {
            this.emit({
              kind: 'tool_use',
              toolUseId: block.id,
              name: block.name,
              input: (block.input ?? {}) as Record<string, unknown>,
            })
          }
        }
        return
      }

      case 'user': {
        // Los mensajes propios ya se registraron al enviarlos; aquí solo
        // interesan los resultados de herramientas que devuelve el CLI.
        const content = message.message.content
        if (typeof content === 'string' || !Array.isArray(content)) return
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          this.emit({
            kind: 'tool_result',
            toolUseId: block.tool_use_id,
            text: flattenToolResult(block.content),
            isError: block.is_error === true,
          })
        }
        return
      }

      case 'result': {
        const costUsd = message.total_cost_usd ?? 0
        this.meta.numTurns += message.num_turns
        this.meta.totalCostUsd += costUsd
        this.touchMeta()
        this.emit({
          kind: 'result',
          costUsd,
          durationMs: message.duration_ms,
          numTurns: message.num_turns,
          isError: message.is_error,
        })
        this.hooks.onResult(this, {
          costUsd,
          durationMs: message.duration_ms,
          numTurns: message.num_turns,
          model: this.meta.model,
        })
        this.setStatus('idle')
        this.armIdleTimer()
        this.hooks.onIdle(this)
        return
      }

      default:
        return
    }
  }

  private async handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; title?: string; description?: string },
  ): Promise<PermissionResult> {
    const id = randomUUID()
    const view: PermissionRequestView = {
      id,
      toolName,
      title: opts.title || `Claude quiere usar ${toolName}`,
      description: opts.description ?? null,
      input,
      suggestionCount: opts.suggestions?.length ?? 0,
      createdAt: Date.now(),
    }

    // Primero las reglas del proyecto. Solo un veredicto explícito evita el
    // prompt; cualquier duda cae al humano.
    const verdict = await this.hooks.evaluatePermission(this, {
      toolName,
      input,
      title: view.title,
    })
    if (verdict && verdict.decision === 'allow') {
      this.emit({ kind: 'notice', text: `Reglas: permitido ${toolName} — ${verdict.reason}` })
      return { behavior: 'allow' }
    }
    if (verdict && verdict.decision === 'deny') {
      this.emit({ kind: 'notice', text: `Reglas: rechazado ${toolName} — ${verdict.reason}` })
      return { behavior: 'deny', message: `Rechazado por las reglas del proyecto: ${verdict.reason}` }
    }

    return new Promise<PermissionResult>((resolve) => {
      // El SDK no impone deadline en los permisos: la promesa queda parada
      // hasta que llegue la respuesta del celular o se aborte la sesión.
      const settle = (result: PermissionResult) => {
        this.pending.delete(id)
        resolve(result)
      }
      this.pending.set(id, { view, resolve: settle, suggestions: opts.suggestions ?? [] })

      opts.signal.addEventListener('abort', () => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        resolve({ behavior: 'deny', message: 'La petición se abortó antes de recibir respuesta.' })
      })

      this.emit({ kind: 'permission', request: view })
      this.setStatus('awaiting_permission')
    })
  }
}

function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: any) => {
      if (block?.type === 'text') return String(block.text ?? '')
      if (block?.type === 'image') return '[imagen]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
