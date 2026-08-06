import { createServer } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { HttpError } from './auth.js'
import { config } from './config.js'
import { fetchIntoProject, readFileView, resolveForStream } from './files.js'
import { addManualEntry, readKnowledge } from './knowledge.js'
import { defaultLinkHint, Links } from './links.js'
import { SessionManager } from './manager.js'
import { readTree } from './projects.js'
import type { Project, ProjectView, StoredEvent, User, UserView } from './types.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: User
    }
  }
}

export function buildServer(manager: SessionManager) {
  const { auth, projects, usage } = manager
  const links = new Links()
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '2mb' }))

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: 2 }))

  // -------------------------------------------------------------- auth

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const user = auth.resolve(bearer(req))
    if (!user) return res.status(401).json({ error: 'Token inválido, revocado o desactivado.' })
    req.user = user
    next()
  })

  const adminOnly = (req: Request, res: Response, next: NextFunction) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo para administradores.' })
    next()
  }

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res)
      } catch (err) {
        if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
        console.error('[api]', err)
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
      }
    }

  // -------------------------------------------------------------- vistas

  const projectView = (project: Project): ProjectView => {
    const sessions = manager.forProject(project.id)
    const lastActivity = sessions.reduce<number | null>((acc, s) => {
      const ts = s.meta.lastMessageAt ?? s.meta.updatedAt
      return acc === null || ts > acc ? ts : acc
    }, null)
    return {
      ...project,
      sessionCount: sessions.length,
      liveSessionCount: sessions.filter((s) => s.isLive).length,
      lastActivityAt: lastActivity,
      ownerName: auth.get(project.ownerId)?.name ?? 'desconocido',
    }
  }

  const userView = (user: User): UserView => {
    const { tokenHash: _drop, ...rest } = user
    return { ...rest, usage: usage.summaryFor(user.id), projectCount: projects.countFor(user.id) }
  }

  const snapshot = (user: User) => ({
    me: userView(user),
    projects: projects.list(user).map(projectView),
    sessions: manager.forUser(user).map((s) => s.toView()),
    limits: user.limits,
    // Los enlaces los ve todo el mundo: cualquiera necesita saber por qué
    // dirección repartir su propio acceso. Gestionarlos sí es cosa del admin.
    links: links.list(),
    defaults: {
      model: config.defaultModel,
      workspace: config.workspace,
      maxLive: config.maxLive,
      localUrl: defaultLinkHint(),
    },
  })

  app.get(
    '/api/me',
    wrap((req, res) => res.json(snapshot(req.user))),
  )

  // ----------------------------------------------------------- proyectos

  app.get(
    '/api/projects',
    wrap((req, res) => res.json({ projects: projects.list(req.user).map(projectView) })),
  )

  app.post(
    '/api/projects',
    wrap(async (req, res) => {
      const project = projects.create(req.user, req.body ?? {})

      // Un proyecto recién creado con una carpeta vacía no sirve de nada: se
      // abre la primera sesión y, si hay descripción, se arranca sola con un
      // prompt derivado de ella. Si algo falla, el proyecto se conserva igual.
      let session = null
      try {
        const created = manager.create(req.user, project, { title: 'Arranque' })
        session = created.toView()
        const kickoff = buildKickoff(project)
        if (kickoff) {
          await manager.send(created, req.user, kickoff)
          session = created.toView()
        }
      } catch (err) {
        console.error('[projects] no se pudo abrir la sesión inicial:', err)
      }

      manager.emit('projects')
      res.status(201).json({ project: projectView(project), session })
    }),
  )

  app.get(
    '/api/projects/:id',
    wrap((req, res) => {
      const project = projects.require(req.params.id, req.user)
      res.json({
        project: projectView(project),
        sessions: manager.forProject(project.id).map((s) => s.toView()),
      })
    }),
  )

  app.patch(
    '/api/projects/:id',
    wrap((req, res) => {
      const project = projects.require(req.params.id, req.user)
      projects.update(project, req.body ?? {})
      manager.emit('projects')
      res.json({ project: projectView(project) })
    }),
  )

  app.delete(
    '/api/projects/:id',
    wrap(async (req, res) => {
      const project = projects.require(req.params.id, req.user)
      await manager.removeProjectSessions(project.id)
      projects.remove(project.id)
      manager.emit('projects')
      // Los archivos NO se borran: quedan en el workspace por si hacen falta.
      res.json({ ok: true, keptFiles: project.dir })
    }),
  )

  app.get(
    '/api/projects/:id/tree',
    wrap((req, res) => {
      const project = projects.require(req.params.id, req.user)
      res.json({ tree: readTree(project) })
    }),
  )

  // ------------------------------------------------------------- archivos

  app.get(
    '/api/projects/:id/files',
    wrap((req, res) => {
      const project = projects.require(req.params.id, req.user)
      const path = String(req.query.path ?? '')
      if (!path) throw new HttpError(400, 'Falta el parámetro path.')
      res.json({ file: readFileView(project, path) })
    }),
  )

  /** Bytes del archivo: alimenta el visor de PDF/imágenes y la descarga. */
  app.get(
    '/api/projects/:id/files/raw',
    wrap((req, res) => {
      const project = projects.require(req.params.id, req.user)
      const path = String(req.query.path ?? '')
      if (!path) throw new HttpError(400, 'Falta el parámetro path.')
      const { full, mime, size } = resolveForStream(project, path)

      const download = req.query.download === '1'
      // `inline` sin sanear el nombre permitiría inyectar cabeceras.
      const name = full.split('/').pop()!.replace(/["\r\n]/g, '')
      res.setHeader('Content-Type', mime)
      res.setHeader('Content-Length', String(size))
      res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`)
      // El contenido lo escribe el agente: sin esto, un HTML del proyecto
      // correría como script en el mismo origen que la app.
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
      res.setHeader('X-Content-Type-Options', 'nosniff')
      createReadStream(full).pipe(res)
    }),
  )

  /** Trae un documento de internet a la carpeta del proyecto. */
  app.post(
    '/api/projects/:id/files/fetch',
    wrap(async (req, res) => {
      const project = projects.require(req.params.id, req.user)
      const url = typeof req.body?.url === 'string' ? req.body.url : ''
      if (!url.trim()) throw new HttpError(400, 'Falta la URL.')
      const result = await fetchIntoProject(project, { url: url.trim(), path: req.body?.path })
      manager.emit('projects')
      res.status(201).json(result)
    }),
  )

  // ----------------------------------------------------------- knowledge

  app.get(
    '/api/projects/:id/knowledge',
    wrap(async (req, res) => {
      const project = projects.require(req.params.id, req.user)
      res.json({ knowledge: await readKnowledge(project) })
    }),
  )

  app.post(
    '/api/projects/:id/knowledge/entries',
    wrap(async (req, res) => {
      const project = projects.require(req.params.id, req.user)
      const content = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
      if (!content) throw new HttpError(400, 'La nota está vacía.')
      addManualEntry(project, { content, sessionTitle: 'nota', userName: req.user.name })
      projects.save()
      manager.emit('projects')
      res.status(201).json({ knowledge: await readKnowledge(project) })
    }),
  )

  app.post(
    '/api/projects/:id/knowledge/refresh',
    wrap(async (req, res) => {
      const project = projects.require(req.params.id, req.user)
      usage.assertWithinBudget(req.user)
      await manager.refreshProjectSummary(project, req.user)
      res.json({ knowledge: await readKnowledge(project) })
    }),
  )

  // ------------------------------------------------------------ sesiones

  app.get(
    '/api/sessions',
    wrap((req, res) => res.json({ sessions: manager.forUser(req.user).map((s) => s.toView()) })),
  )

  app.post(
    '/api/projects/:id/sessions',
    wrap(async (req, res) => {
      const project = projects.require(req.params.id, req.user)
      const session = manager.create(req.user, project, req.body ?? {})
      const first = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
      if (first) await manager.send(session, req.user, first)
      res.status(201).json({ session: session.toView() })
    }),
  )

  app.patch(
    '/api/sessions/:id',
    wrap(async (req, res) => {
      const session = manager.require(req.params.id, req.user)
      const { title, permissionMode, model } = req.body ?? {}
      if (typeof title === 'string' && title.trim()) session.meta.title = title.trim()
      if (typeof permissionMode === 'string') await session.setPermissionMode(permissionMode as never)
      if (typeof model === 'string' && model.trim()) await session.setModel(model.trim())
      res.json({ session: session.toView() })
    }),
  )

  app.delete(
    '/api/sessions/:id',
    wrap(async (req, res) => {
      manager.require(req.params.id, req.user)
      await manager.remove(req.params.id)
      res.json({ ok: true })
    }),
  )

  app.post(
    '/api/sessions/:id/messages',
    wrap(async (req, res) => {
      const session = manager.require(req.params.id, req.user)
      const text = typeof req.body?.text === 'string' ? req.body.text : ''
      if (!text.trim()) throw new HttpError(400, 'El mensaje está vacío.')
      await manager.send(session, req.user, text)
      res.json({ ok: true, session: session.toView() })
    }),
  )

  app.post(
    '/api/sessions/:id/wake',
    wrap(async (req, res) => {
      const session = manager.require(req.params.id, req.user)
      await manager.wake(session, req.user)
      res.json({ session: session.toView() })
    }),
  )

  app.post(
    '/api/sessions/:id/hibernate',
    wrap(async (req, res) => {
      const session = manager.require(req.params.id, req.user)
      // Antes de apagar, se vuelca lo pendiente al knowledge.
      await manager.captureKnowledge(session, true)
      await session.hibernate()
      res.json({ session: session.toView() })
    }),
  )

  app.post(
    '/api/sessions/:id/interrupt',
    wrap(async (req, res) => {
      await manager.require(req.params.id, req.user).interrupt()
      res.json({ ok: true })
    }),
  )

  app.post(
    '/api/sessions/:id/permissions/:permissionId',
    wrap((req, res) => {
      const session = manager.require(req.params.id, req.user)
      const decision = req.body?.decision
      if (!['allow', 'allow_always', 'deny'].includes(decision)) {
        throw new HttpError(400, 'decision debe ser allow, allow_always o deny.')
      }
      const ok = session.resolvePermission(req.params.permissionId, decision, req.body?.message)
      if (!ok) throw new HttpError(409, 'Esa petición de permiso ya no está pendiente.')
      res.json({ ok: true })
    }),
  )

  app.get(
    '/api/sessions/:id/events',
    wrap(async (req, res) => {
      const session = manager.require(req.params.id, req.user)
      const since = Number(req.query.since ?? 0) || 0
      const limit = Math.min(Number(req.query.limit ?? 400) || 400, 2000)
      res.json({ events: await session.history(since, limit), seq: session.seq })
    }),
  )

  // --------------------------------------------------------------- admin

  app.get(
    '/api/admin/users',
    adminOnly,
    wrap((_req, res) => res.json({ users: auth.list().map(userView) })),
  )

  app.post(
    '/api/admin/users',
    adminOnly,
    wrap((req, res) => {
      const { user, token } = auth.create(req.body ?? {})
      manager.emit('projects')
      // El token en claro se devuelve una única vez: no se puede volver a leer.
      res.status(201).json({ user: userView(user), token })
    }),
  )

  app.patch(
    '/api/admin/users/:id',
    adminOnly,
    wrap((req, res) => {
      const user = auth.update(req.params.id, req.body ?? {})
      res.json({ user: userView(user) })
    }),
  )

  app.post(
    '/api/admin/users/:id/rotate',
    adminOnly,
    wrap((req, res) => {
      const { user, token } = auth.rotate(req.params.id)
      res.json({ user: userView(user), token })
    }),
  )

  app.delete(
    '/api/admin/users/:id',
    adminOnly,
    wrap(async (req, res) => {
      const target = auth.get(req.params.id)
      if (!target) throw new HttpError(404, 'Usuario no encontrado.')
      for (const session of manager.forUser({ ...target, role: 'user' } as User)) {
        await manager.remove(session.meta.id)
      }
      auth.remove(req.params.id)
      res.json({ ok: true })
    }),
  )

  // -------------------------------------------------- enlaces de acceso

  app.get(
    '/api/admin/links',
    adminOnly,
    wrap((_req, res) => res.json({ links: links.list() })),
  )

  app.post(
    '/api/admin/links',
    adminOnly,
    wrap((req, res) => {
      const link = links.create(req.body ?? {})
      manager.emit('projects')
      res.status(201).json({ link, links: links.list() })
    }),
  )

  app.patch(
    '/api/admin/links/:id',
    adminOnly,
    wrap((req, res) => {
      const link = links.update(req.params.id, req.body ?? {})
      manager.emit('projects')
      res.json({ link, links: links.list() })
    }),
  )

  app.delete(
    '/api/admin/links/:id',
    adminOnly,
    wrap((req, res) => {
      links.remove(req.params.id)
      manager.emit('projects')
      res.json({ ok: true, links: links.list() })
    }),
  )

  app.get(
    '/api/admin/usage',
    adminOnly,
    wrap((req, res) => {
      const days = Math.min(Number(req.query.days ?? 30) || 30, 365)
      const since = Date.now() - days * 86_400_000
      const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined
      res.json({
        records: usage.query({ since, userId, limit: 500 }).map((rec) => ({
          ...rec,
          userName: auth.get(rec.userId)?.name ?? 'borrado',
          projectName: rec.projectId ? (projects.get(rec.projectId)?.name ?? 'borrado') : null,
        })),
        daily: usage.dailyTotals(days, Date.now(), userId),
        users: auth.list().map(userView),
      })
    }),
  )

  // ----------------------------------------------------------- front PWA

  // La PWA compilada se sirve desde el mismo origen que la API: un solo túnel,
  // sin CORS y sin configurar una URL distinta a la ya abierta.
  const webDir = resolve(fileURLToPath(new URL('../../web/out', import.meta.url)))
  if (existsSync(webDir)) {
    app.use(
      express.static(webDir, {
        index: 'index.html',
        maxAge: '1y',
        setHeaders(res, path) {
          // Los assets de /_next llevan hash en el nombre y pueden cachearse
          // para siempre. El HTML, el manifest y el service worker NO: si se
          // cachean, tras cada despliegue el navegador pide chunks que ya no
          // existen y la app se queda en la versión vieja.
          if (!path.includes(`${sep}_next${sep}`)) {
            res.setHeader('Cache-Control', 'no-cache')
          }
        },
      }),
    )
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(join(webDir, 'index.html'))
    })
  } else {
    app.get('/', (_req, res) =>
      res.type('text/plain').send('API lista. Compila el front con `npm run build` en web/.'),
    )
  }

  const server = createServer(app)
  attachWebSocket(server, manager, snapshot)
  return server
}

/**
 * Primer mensaje de la sesión de arranque. Pide un plan corto antes de tocar
 * nada: empezar a escribir código desde una descripción de dos frases produce
 * casi siempre lo que no era.
 */
function buildKickoff(project: Project): string | null {
  const description = project.description.trim()
  if (!description) return null
  return [
    `Proyecto nuevo: "${project.name}".`,
    '',
    'Descripción del dueño:',
    description,
    '',
    'La carpeta está prácticamente vacía. Antes de escribir código:',
    '1. Dime en 3-4 líneas qué vas a construir y con qué stack, y por qué.',
    '2. Lista los primeros 3-5 pasos concretos.',
    '',
    'No ejecutes nada todavía: espera mi confirmación.',
  ].join('\n')
}

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  const q = req.query.token
  return typeof q === 'string' ? q : undefined
}

// --------------------------------------------------------------- websocket

type Client = { socket: WebSocket; user: User; subscriptions: Set<string>; alive: boolean }

/**
 * Un solo WebSocket multiplexa todo: el celular se suscribe a las sesiones que
 * tiene abiertas y, al reconectar, manda el último `seq` visto para recibir
 * solo lo perdido. El servidor sigue recibiendo eventos aunque no haya nadie
 * conectado — de ahí que las sesiones sigan activas.
 */
function attachWebSocket(
  server: ReturnType<typeof createServer>,
  manager: SessionManager,
  snapshot: (user: User) => unknown,
) {
  const wss = new WebSocketServer({ server, path: '/ws' })
  const clients = new Set<Client>()

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const user = manager.auth.resolve(url.searchParams.get('token') ?? undefined)
    if (!user) {
      socket.close(4401, 'Token inválido')
      return
    }

    const client: Client = { socket, user, subscriptions: new Set(), alive: true }
    clients.add(client)
    send(socket, { t: 'hello', ...(snapshot(user) as object) })

    socket.on('pong', () => {
      client.alive = true
    })

    socket.on('message', async (raw) => {
      let msg: any
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (msg.t === 'ping') return send(socket, { t: 'pong' })

      if (msg.t === 'subscribe' && typeof msg.sessionId === 'string') {
        const session = manager.get(msg.sessionId)
        // Nunca se sirve una sesión ajena por el canal de tiempo real.
        if (!session) return
        if (client.user.role !== 'admin' && session.meta.userId !== client.user.id) return
        client.subscriptions.add(msg.sessionId)
        const events = await session.history(Number(msg.since ?? 0) || 0)
        send(socket, { t: 'replay', sessionId: session.meta.id, events, seq: session.seq })
        return
      }

      if (msg.t === 'unsubscribe' && typeof msg.sessionId === 'string') {
        client.subscriptions.delete(msg.sessionId)
      }
    })

    socket.on('close', () => clients.delete(client))
    socket.on('error', () => clients.delete(client))
  })

  // Ping cada 25 s: mantiene viva la conexión a través del túnel y detecta
  // clientes muertos cuando el celular se duerme.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate()
        clients.delete(client)
        continue
      }
      client.alive = false
      try {
        client.socket.ping()
      } catch {
        clients.delete(client)
      }
    }
  }, 25_000)
  heartbeat.unref()

  manager.on('event', ({ sessionId, event }: { sessionId: string; event: StoredEvent }) => {
    for (const client of clients) {
      if (client.subscriptions.has(sessionId)) send(client.socket, { t: 'event', sessionId, event })
    }
  })

  let timer: NodeJS.Timeout | null = null
  const broadcastSnapshot = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      for (const client of clients) send(client.socket, { t: 'snapshot', ...(snapshot(client.user) as object) })
    }, 150)
  }

  manager.on('sessions', broadcastSnapshot)
  manager.on('projects', broadcastSnapshot)
}

function send(socket: WebSocket, payload: unknown) {
  if (socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify(payload))
}
