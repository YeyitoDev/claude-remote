import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { Auth, HttpError } from './auth.js'
import { config } from './config.js'
import { condenseEvents, generateEntry, refreshSummary } from './knowledge.js'
import { Projects } from './projects.js'
import { ClaudeSession } from './session.js'
import { deleteEvents, lastSeq, loadSessions, saveSessions } from './store.js'
import { evaluateRules } from './rules.js'
import type { ModelRoles, Project, SessionMeta, StoredEvent, User } from './types.js'
import { Usage } from './usage.js'

/** Cada cuántas entradas se regenera el resumen vivo del proyecto. */
const SUMMARY_EVERY = 5

/**
 * Orquestador: dueño de las sesiones y de cómo se relacionan con proyectos,
 * usuarios, límites y knowledge. Los routers HTTP solo traducen peticiones.
 */
export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ClaudeSession>()
  private knowledgeAt = new Map<string, number>()
  private knowledgeBusy = new Set<string>()

  constructor(
    readonly auth: Auth,
    readonly projects: Projects,
    readonly usage: Usage,
  ) {
    super()
    for (const meta of loadSessions<SessionMeta>()) {
      this.sessions.set(meta.id, new ClaudeSession(meta, this.hooks()))
    }
  }

  /** Continúa la numeración de eventos donde la dejó el proceso anterior. */
  async restoreSeqs() {
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        session.seq = await lastSeq(session.meta.id)
      }),
    )
  }

  private hooks() {
    return {
      onEvent: (session: ClaudeSession, event: StoredEvent) => {
        this.emit('event', { sessionId: session.meta.id, event })
        this.emit('sessions')
      },
      onMetaChange: () => {
        this.persist()
        this.emit('sessions')
      },
      onResult: (
        session: ClaudeSession,
        result: { costUsd: number; durationMs: number; numTurns: number; model: string },
      ) => {
        this.usage.record({
          ts: Date.now(),
          userId: session.meta.userId,
          projectId: session.meta.projectId,
          sessionId: session.meta.id,
          model: result.model,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          numTurns: result.numTurns,
          kind: 'session',
        })
        this.projects.touch(session.meta.projectId)
      },
      onIdle: (session: ClaudeSession) => {
        void this.captureKnowledge(session)
      },
      modelsFor: (session: ClaudeSession): ModelRoles | null =>
        this.projects.get(session.meta.projectId)?.models ?? null,
      evaluatePermission: async (
        session: ClaudeSession,
        request: { toolName: string; input: Record<string, unknown>; title: string },
      ) => {
        const project = this.projects.get(session.meta.projectId)
        if (!project?.autoApprove || !project.rules.trim()) return null

        const model = project.models.rules ?? config.knowledgeModel
        const result = await evaluateRules(project, model, request)
        if (result.costUsd > 0) {
          this.usage.record({
            ts: Date.now(),
            userId: session.meta.userId,
            projectId: project.id,
            sessionId: session.meta.id,
            model,
            costUsd: result.costUsd,
            durationMs: 0,
            numTurns: 0,
            kind: 'rules',
          })
        }
        return { decision: result.decision, reason: result.reason }
      },
    }
  }

  private persist() {
    saveSessions([...this.sessions.values()].map((s) => s.meta))
  }

  // ------------------------------------------------------------- consultas

  get(id: string): ClaudeSession | undefined {
    return this.sessions.get(id)
  }

  /** Lanza 404/403 según corresponda. El admin ve todas. */
  require(id: string, user: User): ClaudeSession {
    const session = this.sessions.get(id)
    if (!session) throw new HttpError(404, 'Sesión no encontrada.')
    if (user.role !== 'admin' && session.meta.userId !== user.id) {
      throw new HttpError(403, 'Esa sesión no es tuya.')
    }
    return session
  }

  forProject(projectId: string): ClaudeSession[] {
    return [...this.sessions.values()]
      .filter((s) => s.meta.projectId === projectId)
      .sort((a, b) => (b.meta.lastMessageAt ?? b.meta.updatedAt) - (a.meta.lastMessageAt ?? a.meta.updatedAt))
  }

  forUser(user: User): ClaudeSession[] {
    const all = [...this.sessions.values()]
    const visible = user.role === 'admin' ? all : all.filter((s) => s.meta.userId === user.id)
    return visible.sort(
      (a, b) => (b.meta.lastMessageAt ?? b.meta.updatedAt) - (a.meta.lastMessageAt ?? a.meta.updatedAt),
    )
  }

  liveCountFor(userId: string): number {
    return [...this.sessions.values()].filter((s) => s.isLive && s.meta.userId === userId).length
  }

  // -------------------------------------------------------------- acciones

  create(
    user: User,
    project: Project,
    input: { title?: string; model?: string; permissionMode?: PermissionMode },
  ): ClaudeSession {
    this.usage.assertWithinBudget(user)

    const now = Date.now()
    const existing = this.forProject(project.id).length
    const meta: SessionMeta = {
      id: randomUUID(),
      projectId: project.id,
      userId: user.id,
      title: input.title?.trim() || `Sesión ${existing + 1}`,
      // El cwd lo fija el proyecto: el usuario nunca elige ruta.
      cwd: project.dir,
      model: input.model || project.models.main,
      permissionMode: input.permissionMode || 'default',
      sdkSessionId: null,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      archived: false,
      totalCostUsd: 0,
      numTurns: 0,
      knowledgeSeq: 0,
    }
    const session = new ClaudeSession(meta, this.hooks())
    this.sessions.set(meta.id, session)
    this.persist()
    this.emit('sessions')
    return session
  }

  /**
   * Levanta el proceso respetando dos topes: el global de la instalación y el
   * del usuario. Si el global está lleno se hiberna la sesión ociosa más
   * antigua — no se pierde nada, se reanuda con `resume`.
   */
  async wake(session: ClaudeSession, user: User) {
    if (session.isLive) return

    const perUser = user.limits.maxLiveSessions
    if (perUser !== null && this.liveCountFor(user.id) >= perUser) {
      const own = [...this.sessions.values()]
        .filter((s) => s.isLive && s.meta.userId === user.id && s.status === 'idle')
        .sort((a, b) => (a.meta.lastMessageAt ?? 0) - (b.meta.lastMessageAt ?? 0))[0]
      if (!own) {
        throw new HttpError(429, `Tienes ${perUser} sesiones ocupadas a la vez. Espera a que alguna termine.`)
      }
      await own.hibernate()
    }

    const live = [...this.sessions.values()].filter((s) => s.isLive)
    if (live.length >= config.maxLive) {
      const victim = live
        .filter((s) => s.status === 'idle')
        .sort((a, b) => (a.meta.lastMessageAt ?? 0) - (b.meta.lastMessageAt ?? 0))[0]
      if (!victim) {
        throw new HttpError(429, `El servidor tiene ${live.length} sesiones ocupadas. Reintenta en un momento.`)
      }
      await victim.hibernate()
    }

    await session.wake()
  }

  async send(session: ClaudeSession, user: User, text: string, attachments: string[] = []) {
    this.usage.assertWithinBudget(user)
    if (!session.isLive) await this.wake(session, user)
    await session.send(text, attachments)
  }

  async remove(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    await session.destroy()
    this.sessions.delete(id)
    deleteEvents(id)
    this.persist()
    this.emit('sessions')
  }

  async removeProjectSessions(projectId: string) {
    for (const session of this.forProject(projectId)) {
      await this.remove(session.meta.id)
    }
  }

  async shutdown() {
    await Promise.all([...this.sessions.values()].map((s) => s.destroy()))
    this.persist()
  }

  // -------------------------------------------------------------- knowledge

  /**
   * Vuelca al knowledge lo que pasó desde el último volcado. Se dispara al
   * quedar la sesión libre, con debounce: una ráfaga de turnos cortos produce
   * una entrada, no cinco.
   */
  async captureKnowledge(session: ClaudeSession, force = false) {
    const project = this.projects.get(session.meta.projectId)
    if (!project) return
    if (!force && !project.autoKnowledge) return

    const id = session.meta.id
    if (this.knowledgeBusy.has(id)) return

    const last = this.knowledgeAt.get(id) ?? 0
    if (!force && Date.now() - last < config.knowledgeDebounceMs) return
    if (session.seq <= session.meta.knowledgeSeq) return

    this.knowledgeBusy.add(id)
    try {
      const events = await session.history(session.meta.knowledgeSeq, 2000)
      const transcript = condenseEvents(events)
      const upTo = session.seq

      const user = this.auth.get(session.meta.userId)
      const { entry, costUsd } = await generateEntry(project, {
        transcript,
        sessionId: id,
        sessionTitle: session.meta.title,
        userName: user?.name ?? 'desconocido',
      })

      session.meta.knowledgeSeq = upTo
      this.knowledgeAt.set(id, Date.now())
      this.persist()

      if (costUsd > 0) this.recordKnowledgeCost(session.meta.userId, project.id, costUsd)

      if (entry) {
        this.projects.save()
        this.emit('projects')
        if (project.knowledgeEntries % SUMMARY_EVERY === 0) {
          const { costUsd: summaryCost } = await refreshSummary(project)
          this.projects.save()
          if (summaryCost > 0) this.recordKnowledgeCost(session.meta.userId, project.id, summaryCost)
          this.emit('projects')
        }
      }
    } catch (err) {
      console.error(`[knowledge] ${session.meta.id}:`, err)
    } finally {
      this.knowledgeBusy.delete(id)
    }
  }

  async refreshProjectSummary(project: Project, user: User) {
    const { costUsd } = await refreshSummary(project)
    this.projects.save()
    if (costUsd > 0) this.recordKnowledgeCost(user.id, project.id, costUsd)
    this.emit('projects')
  }

  private recordKnowledgeCost(userId: string, projectId: string, costUsd: number) {
    this.usage.record({
      ts: Date.now(),
      userId,
      projectId,
      sessionId: null,
      model: this.projects.get(projectId)?.models.knowledge ?? config.knowledgeModel,
      costUsd,
      durationMs: 0,
      numTurns: 0,
      kind: 'knowledge',
    })
  }
}

export { HttpError }
