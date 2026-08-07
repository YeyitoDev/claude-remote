'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api, loadConnection, saveConnection, wsUrl, type Connection } from './api'
import { consumeInviteFromUrl } from './invite'
import type {
  AccessLink,
  Defaults,
  PermissionMode,
  ProjectView,
  SessionView,
  Snapshot,
  StoredEvent,
  UserView,
} from './types'

type ConnState = 'idle' | 'connecting' | 'connected' | 'unauthorized' | 'offline'

/** Navegación: la app es una sola página con estas vistas. */
export type View =
  | { name: 'projects' }
  | { name: 'project'; projectId: string }
  | { name: 'session'; sessionId: string }
  | { name: 'admin' }

type Store = {
  conn: Connection | null
  connState: ConnState
  error: string | null
  me: UserView | null
  defaults: Defaults | null
  projects: ProjectView[]
  sessions: SessionView[]
  links: AccessLink[]
  events: Record<string, StoredEvent[]>
  streaming: Record<string, string>

  view: View
  go: (view: View) => void
  back: () => void

  connect: (conn: Connection) => Promise<void>
  disconnect: () => void
  refresh: () => Promise<void>
  /** Cambia el token de la conexión actual sin cerrar sesión. */
  adoptToken: (token: string) => Promise<void>

  openSession: (sessionId: string) => void
  send: (id: string, text: string, attachments?: string[]) => Promise<void>
  interrupt: (id: string) => Promise<void>
  respond: (id: string, permissionId: string, decision: 'allow' | 'allow_always' | 'deny') => Promise<void>
  createSession: (
    projectId: string,
    input: { title?: string; model?: string; permissionMode?: PermissionMode; message?: string },
  ) => Promise<SessionView>
  updateSession: (id: string, body: { title?: string; permissionMode?: PermissionMode; model?: string }) => Promise<void>
  removeSession: (id: string) => Promise<void>
  hibernate: (id: string) => Promise<void>
  wake: (id: string) => Promise<void>
}

const StoreContext = createContext<Store | null>(null)
const MAX_EVENTS_IN_MEMORY = 800

export function StoreProvider({ children }: { children: ReactNode }) {
  const [conn, setConn] = useState<Connection | null>(null)
  const [connState, setConnState] = useState<ConnState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [me, setMe] = useState<UserView | null>(null)
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [links, setLinks] = useState<AccessLink[]>([])
  const [events, setEvents] = useState<Record<string, StoredEvent[]>>({})
  const [streaming, setStreaming] = useState<Record<string, string>>({})
  const [stack, setStack] = useState<View[]>([{ name: 'projects' }])

  const socketRef = useRef<WebSocket | null>(null)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef = useRef(0)
  const subsRef = useRef<Set<string>>(new Set())
  const seqRef = useRef<Record<string, number>>({})
  const wantOpenRef = useRef(false)

  const view = stack[stack.length - 1]

  const go = useCallback((next: View) => setStack((prev) => [...prev, next]), [])
  const back = useCallback(() => setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev)), [])

  // ------------------------------------------------------------ websocket

  const applySnapshot = useCallback((snap: Partial<Snapshot>) => {
    if (snap.me) setMe(snap.me)
    if (snap.projects) setProjects(snap.projects)
    if (snap.sessions) setSessions(snap.sessions)
    if (snap.links) setLinks(snap.links)
    if (snap.defaults) setDefaults(snap.defaults)
  }, [])

  const applyEvents = useCallback((sessionId: string, incoming: StoredEvent[], replace = false) => {
    if (!incoming.length && !replace) return
    setEvents((prev) => {
      const existing = replace ? [] : (prev[sessionId] ?? [])
      const lastSeq = existing.length ? existing[existing.length - 1].seq : 0
      const fresh = incoming.filter((e) => e.seq > lastSeq)
      if (!fresh.length && !replace) return prev
      return { ...prev, [sessionId]: [...existing, ...fresh].slice(-MAX_EVENTS_IN_MEMORY) }
    })
    const last = incoming[incoming.length - 1]
    if (last) seqRef.current[sessionId] = Math.max(seqRef.current[sessionId] ?? 0, last.seq)

    // El buffer de streaming se limpia en cuanto llega el bloque definitivo.
    setStreaming((prev) => {
      let buffer = prev[sessionId] ?? ''
      let touched = false
      for (const event of incoming) {
        if (event.kind === 'delta') {
          buffer += event.text
          touched = true
        } else if (event.kind === 'assistant' || event.kind === 'result' || event.kind === 'tool_use') {
          if (buffer) touched = true
          buffer = ''
        }
      }
      return touched ? { ...prev, [sessionId]: buffer } : prev
    })
  }, [])

  const openSocket = useCallback(
    (connection: Connection) => {
      if (socketRef.current) {
        socketRef.current.onclose = null
        socketRef.current.close()
      }
      setConnState('connecting')
      const socket = new WebSocket(wsUrl(connection))
      socketRef.current = socket

      socket.onopen = () => {
        attemptRef.current = 0
        setConnState('connected')
        setError(null)
        for (const id of subsRef.current) {
          socket.send(JSON.stringify({ t: 'subscribe', sessionId: id, since: seqRef.current[id] ?? 0 }))
        }
      }

      socket.onmessage = (raw) => {
        let msg: any
        try {
          msg = JSON.parse(raw.data as string)
        } catch {
          return
        }
        if (msg.t === 'hello' || msg.t === 'snapshot') applySnapshot(msg)
        else if (msg.t === 'replay') {
          seqRef.current[msg.sessionId] = 0
          applyEvents(msg.sessionId, msg.events ?? [], true)
        } else if (msg.t === 'event') applyEvents(msg.sessionId, [msg.event])
      }

      socket.onclose = (ev) => {
        socketRef.current = null
        if (ev.code === 4401) {
          setConnState('unauthorized')
          setError('El servidor rechazó el token.')
          return
        }
        if (!wantOpenRef.current) return
        setConnState('offline')
        // Backoff con techo de 15 s: el celular se duerme y vuelve mucho.
        const delay = Math.min(1000 * 2 ** attemptRef.current++, 15_000)
        retryRef.current = setTimeout(() => openSocket(connection), delay)
      }
    },
    [applyEvents, applySnapshot],
  )

  const connect = useCallback(
    async (connection: Connection) => {
      setError(null)
      setConnState('connecting')
      try {
        applySnapshot(await api.me(connection))
      } catch (err: any) {
        setConnState(err?.status === 401 ? 'unauthorized' : 'offline')
        setError(err?.message ?? 'No se pudo conectar.')
        throw err
      }
      wantOpenRef.current = true
      setConn(connection)
      saveConnection(connection)
      setStack([{ name: 'projects' }])
      openSocket(connection)
    },
    [applySnapshot, openSocket],
  )

  const disconnect = useCallback(() => {
    wantOpenRef.current = false
    if (retryRef.current) clearTimeout(retryRef.current)
    socketRef.current?.close()
    socketRef.current = null
    subsRef.current.clear()
    seqRef.current = {}
    setConn(null)
    setConnState('idle')
    setMe(null)
    setProjects([])
    setSessions([])
    setLinks([])
    setEvents({})
    setStreaming({})
    setStack([{ name: 'projects' }])
    saveConnection(null)
  }, [])

  const refresh = useCallback(async () => {
    if (!conn) return
    applySnapshot(await api.me(conn))
  }, [conn, applySnapshot])

  // Reconexión inmediata al volver a primer plano en vez de esperar el backoff.
  useEffect(() => {
    const revive = () => {
      if (!wantOpenRef.current || !conn) return
      if (document.visibilityState !== 'visible') return
      if (socketRef.current?.readyState === WebSocket.OPEN) return
      if (retryRef.current) clearTimeout(retryRef.current)
      attemptRef.current = 0
      openSocket(conn)
    }
    document.addEventListener('visibilitychange', revive)
    window.addEventListener('online', revive)
    return () => {
      document.removeEventListener('visibilitychange', revive)
      window.removeEventListener('online', revive)
    }
  }, [conn, openSocket])

  useEffect(() => {
    // La invitación manda sobre la sesión guardada: si alguien abre un enlace
    // con otro token es porque quiere entrar con ese.
    const invite = consumeInviteFromUrl()
    const target = invite ?? loadConnection()
    if (target) void connect(target).catch(() => undefined)

    // Tocar un enlace con la app ya abierta solo cambia el fragmento y no
    // recarga nada, así que sin esto la invitación no haría absolutamente nada.
    const onHashChange = () => {
      const next = consumeInviteFromUrl()
      if (next) void connect(next).catch(() => undefined)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------- acciones

  const guard = useCallback(() => {
    if (!conn) throw new Error('Sin conexión configurada.')
    return conn
  }, [conn])

  const openSession = useCallback(
    (sessionId: string) => {
      subsRef.current.add(sessionId)
      const socket = socketRef.current
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'subscribe', sessionId, since: seqRef.current[sessionId] ?? 0 }))
      }
      go({ name: 'session', sessionId })
    },
    [go],
  )

  const patchSession = useCallback((session: SessionView) => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === session.id)
      if (idx === -1) return [session, ...prev]
      const next = [...prev]
      next[idx] = session
      return next
    })
  }, [])

  const value = useMemo<Store>(
    () => ({
      conn,
      connState,
      error,
      me,
      defaults,
      projects,
      sessions,
      links,
      events,
      streaming,
      view,
      go,
      back,
      connect,
      disconnect,
      refresh,
      async adoptToken(token) {
        await connect({ url: guard().url, token })
      },
      openSession,
      async send(id, text, attachments) {
        await api.sendMessage(guard(), id, text, attachments)
      },
      async interrupt(id) {
        await api.interrupt(guard(), id)
      },
      async respond(id, permissionId, decision) {
        await api.respondPermission(guard(), id, permissionId, decision)
      },
      async createSession(projectId, input) {
        const { session } = await api.createSession(guard(), projectId, input)
        patchSession(session)
        return session
      },
      async updateSession(id, body) {
        const { session } = await api.updateSession(guard(), id, body)
        patchSession(session)
      },
      async removeSession(id) {
        await api.deleteSession(guard(), id)
        setSessions((prev) => prev.filter((s) => s.id !== id))
        setEvents((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        subsRef.current.delete(id)
      },
      async hibernate(id) {
        patchSession((await api.hibernate(guard(), id)).session)
      },
      async wake(id) {
        patchSession((await api.wake(guard(), id)).session)
      },
    }),
    [
      conn,
      connState,
      error,
      me,
      defaults,
      projects,
      sessions,
      links,
      events,
      streaming,
      view,
      go,
      back,
      connect,
      disconnect,
      refresh,
      openSession,
      guard,
      patchSession,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore fuera de StoreProvider')
  return store
}
