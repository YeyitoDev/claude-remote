import type {
  AccessLink,
  FileView,
  KnowledgeView,
  Limits,
  PermissionMode,
  ModelRoles,
  ProjectView,
  Role,
  SessionView,
  Snapshot,
  StoredEvent,
  TreeNode,
  UsageRecordView,
  UserView,
} from './types'

export type Connection = { url: string; token: string }

const STORAGE_KEY = 'claude-remote.connection'

export function loadConnection(): Connection | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.url === 'string' && typeof parsed?.token === 'string') return parsed
  } catch {
    /* storage corrupto */
  }
  return null
}

export function saveConnection(conn: Connection | null) {
  if (conn) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conn))
  else window.localStorage.removeItem(STORAGE_KEY)
}

/** Normaliza lo que se escriba: `localhost:8787`, con o sin esquema o slash final. */
export function normalizeUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '')
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`
  return url
}

export function wsUrl(conn: Connection): string {
  const url = new URL(conn.url)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  url.searchParams.set('token', conn.token)
  return url.toString()
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(conn: Connection, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${conn.url}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${conn.token}`,
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  const body = text ? JSON.parse(text) : {}
  if (!res.ok) throw new ApiError(res.status, body?.error || `Error ${res.status}`)
  return body as T
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

export const api = {
  me: (c: Connection) => request<Snapshot>(c, '/api/me'),

  // proyectos
  projects: (c: Connection) => request<{ projects: ProjectView[] }>(c, '/api/projects'),
  project: (c: Connection, id: string) =>
    request<{ project: ProjectView; sessions: SessionView[] }>(c, `/api/projects/${id}`),
  createProject: (c: Connection, body: { name: string; description?: string }) =>
    request<{ project: ProjectView; session: SessionView | null }>(c, '/api/projects', post(body)),
  updateProject: (
    c: Connection,
    id: string,
    body: {
      name?: string
      description?: string
      autoKnowledge?: boolean
      models?: Partial<ModelRoles>
      rules?: string
      autoApprove?: boolean
    },
  ) => request<{ project: ProjectView }>(c, `/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteProject: (c: Connection, id: string) =>
    request<{ ok: true; keptFiles: string }>(c, `/api/projects/${id}`, { method: 'DELETE' }),
  tree: (c: Connection, id: string) => request<{ tree: TreeNode }>(c, `/api/projects/${id}/tree`),

  // archivos
  file: (c: Connection, id: string, path: string) =>
    request<{ file: FileView }>(c, `/api/projects/${id}/files?path=${encodeURIComponent(path)}`),
  fetchFromWeb: (c: Connection, id: string, body: { url: string; path?: string }) =>
    request<{ path: string; size: number; mime: string }>(c, `/api/projects/${id}/files/fetch`, post(body)),
  /**
   * Descarga los bytes con el token en la cabecera y devuelve un blob URL.
   * Es lo que permite mostrar PDFs e imágenes sin meter el token en la URL.
   */
  async fileBlobUrl(c: Connection, id: string, path: string): Promise<string> {
    const res = await fetch(`${c.url}/api/projects/${id}/files/raw?path=${encodeURIComponent(path)}`, {
      headers: { authorization: `Bearer ${c.token}` },
    })
    if (!res.ok) throw new ApiError(res.status, `No se pudo leer el archivo (${res.status})`)
    return URL.createObjectURL(await res.blob())
  },

  // knowledge
  knowledge: (c: Connection, id: string) =>
    request<{ knowledge: KnowledgeView }>(c, `/api/projects/${id}/knowledge`),
  addNote: (c: Connection, id: string, content: string) =>
    request<{ knowledge: KnowledgeView }>(c, `/api/projects/${id}/knowledge/entries`, post({ content })),
  refreshKnowledge: (c: Connection, id: string) =>
    request<{ knowledge: KnowledgeView }>(c, `/api/projects/${id}/knowledge/refresh`, post()),

  // sesiones
  createSession: (
    c: Connection,
    projectId: string,
    body: { title?: string; model?: string; permissionMode?: PermissionMode; message?: string },
  ) => request<{ session: SessionView }>(c, `/api/projects/${projectId}/sessions`, post(body)),
  updateSession: (
    c: Connection,
    id: string,
    body: { title?: string; permissionMode?: PermissionMode; model?: string },
  ) => request<{ session: SessionView }>(c, `/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSession: (c: Connection, id: string) =>
    request<{ ok: true }>(c, `/api/sessions/${id}`, { method: 'DELETE' }),
  sendMessage: (c: Connection, id: string, text: string) =>
    request<{ ok: true }>(c, `/api/sessions/${id}/messages`, post({ text })),
  wake: (c: Connection, id: string) =>
    request<{ session: SessionView }>(c, `/api/sessions/${id}/wake`, post()),
  hibernate: (c: Connection, id: string) =>
    request<{ session: SessionView }>(c, `/api/sessions/${id}/hibernate`, post()),
  interrupt: (c: Connection, id: string) =>
    request<{ ok: true }>(c, `/api/sessions/${id}/interrupt`, post()),
  respondPermission: (
    c: Connection,
    id: string,
    permissionId: string,
    decision: 'allow' | 'allow_always' | 'deny',
  ) =>
    request<{ ok: true }>(c, `/api/sessions/${id}/permissions/${permissionId}`, post({ decision })),
  events: (c: Connection, id: string, since = 0) =>
    request<{ events: StoredEvent[]; seq: number }>(c, `/api/sessions/${id}/events?since=${since}`),

  // admin
  users: (c: Connection) => request<{ users: UserView[] }>(c, '/api/admin/users'),
  createUser: (c: Connection, body: { name: string; role?: Role; limits?: Partial<Limits> }) =>
    request<{ user: UserView; token: string }>(c, '/api/admin/users', post(body)),
  updateUser: (
    c: Connection,
    id: string,
    body: { name?: string; role?: Role; disabled?: boolean; limits?: Partial<Limits> },
  ) => request<{ user: UserView }>(c, `/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  rotateToken: (c: Connection, id: string) =>
    request<{ user: UserView; token: string }>(c, `/api/admin/users/${id}/rotate`, post()),
  deleteUser: (c: Connection, id: string) =>
    request<{ ok: true }>(c, `/api/admin/users/${id}`, { method: 'DELETE' }),
  links: (c: Connection) => request<{ links: AccessLink[] }>(c, '/api/admin/links'),
  createLink: (c: Connection, body: { label?: string; url: string; note?: string; primary?: boolean }) =>
    request<{ links: AccessLink[] }>(c, '/api/admin/links', post(body)),
  updateLink: (
    c: Connection,
    id: string,
    body: { label?: string; url?: string; note?: string; primary?: boolean },
  ) => request<{ links: AccessLink[] }>(c, `/api/admin/links/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteLink: (c: Connection, id: string) =>
    request<{ links: AccessLink[] }>(c, `/api/admin/links/${id}`, { method: 'DELETE' }),

  usage: (c: Connection, days = 30, userId?: string) =>
    request<{
      records: UsageRecordView[]
      daily: { date: string; usd: number; turns: number }[]
      users: UserView[]
    }>(c, `/api/admin/usage?days=${days}${userId ? `&userId=${userId}` : ''}`),
}
