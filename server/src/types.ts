import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'

// ------------------------------------------------------------------ usuarios

export type Role = 'admin' | 'user'

export type Limits = {
  /** Gasto máximo en USD por mes natural. null = sin límite. */
  monthlyUsd: number | null
  maxProjects: number | null
  /** Procesos del CLI simultáneos de este usuario. */
  maxLiveSessions: number | null
}

export type User = {
  id: string
  name: string
  role: Role
  /** Solo se guarda el hash: el token en claro se muestra una vez al crearlo. */
  tokenHash: string
  /** Primeros caracteres del token, para que el admin identifique cuál es cuál. */
  tokenHint: string
  disabled: boolean
  limits: Limits
  createdAt: number
  lastSeenAt: number | null
}

export type UserView = Omit<User, 'tokenHash'> & {
  usage: UsageSummary
  projectCount: number
}

/** Una dirección por la que se llega al servidor desde fuera. */
export type AccessLink = {
  id: string
  label: string
  /** Solo el origen, sin ruta: `https://algo.trycloudflare.com`. */
  url: string
  note: string
  /** El que se usa por defecto al generar invitaciones. */
  primary: boolean
  createdAt: number
}

// ----------------------------------------------------------------- proyectos

/** Un modelo por rol. `null` = usar el principal. */
export type ModelRoles = {
  /** Modelo de trabajo de las sesiones. */
  main: string
  /** Se usa mientras la sesión está en modo plan; al salir vuelve al principal. */
  plan: string | null
  /** Evalúa las reglas de auto-aprobación de permisos. */
  rules: string | null
  /** Resume el knowledge. */
  knowledge: string | null
}

export type Project = {
  id: string
  slug: string
  name: string
  description: string
  ownerId: string
  /** Ruta absoluta dentro del workspace. Nunca la elige el usuario. */
  dir: string
  createdAt: number
  updatedAt: number
  /** Resumen generado a partir del knowledge. */
  summary: string | null
  summaryUpdatedAt: number | null
  autoKnowledge: boolean
  knowledgeEntries: number
  models: ModelRoles
  /** Reglas en lenguaje natural que evalúa el modelo de reglas. */
  rules: string
  /** Si está activo, el modelo de reglas decide los permisos antes de preguntarte. */
  autoApprove: boolean
}

export type ProjectView = Project & {
  sessionCount: number
  liveSessionCount: number
  lastActivityAt: number | null
  ownerName: string
}

export type TreeNode = {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
  mtimeMs?: number
  children?: TreeNode[]
  truncated?: boolean
}

/** Cómo se debe visualizar un archivo en el cliente. */
export type FileKind = 'markdown' | 'text' | 'image' | 'pdf' | 'docx' | 'binary'

export type FileView = {
  path: string
  name: string
  kind: FileKind
  size: number
  mtimeMs: number
  mime: string
  /** Solo para markdown/text; el resto se pide por la ruta `raw`. */
  content: string | null
  truncated: boolean
}

// ------------------------------------------------------------------ knowledge

export type KnowledgeEntry = {
  /** YYYY-MM-DD */
  date: string
  time: string
  sessionId: string
  sessionTitle: string
  userName: string
  /** Markdown ya formateado. */
  content: string
  ts: number
  manual: boolean
}

export type KnowledgeView = {
  summary: string | null
  summaryUpdatedAt: number | null
  /** Agrupadas por fecha, de más reciente a más antigua. */
  days: { date: string; entries: KnowledgeEntry[] }[]
  totalEntries: number
}

// -------------------------------------------------------------------- uso

export type UsageRecord = {
  ts: number
  userId: string
  projectId: string | null
  sessionId: string | null
  model: string
  costUsd: number
  durationMs: number
  numTurns: number
  kind: 'session' | 'knowledge' | 'rules'
}

export type UsageSummary = {
  monthUsd: number
  monthTurns: number
  totalUsd: number
  totalTurns: number
}

// ---------------------------------------------------------------- sesiones

export type SessionStatus = 'dormant' | 'starting' | 'idle' | 'busy' | 'awaiting_permission' | 'error'

export type SessionMeta = {
  id: string
  projectId: string
  userId: string
  title: string
  cwd: string
  model: string
  permissionMode: PermissionMode
  sdkSessionId: string | null
  createdAt: number
  updatedAt: number
  lastMessageAt: number | null
  archived: boolean
  totalCostUsd: number
  numTurns: number
  /** Último seq volcado al knowledge, para no repetir contenido. */
  knowledgeSeq: number
}

export type SessionView = SessionMeta & {
  status: SessionStatus
  seq: number
  pendingPermissions: PermissionRequestView[]
  preview: string | null
}

export type PermissionRequestView = {
  id: string
  toolName: string
  title: string
  description: string | null
  input: Record<string, unknown>
  suggestionCount: number
  createdAt: number
}

export type SessionEvent =
  | { kind: 'status'; status: SessionStatus }
  | { kind: 'user'; text: string }
  /**
   * Archivos que subió el usuario para este turno. Va aparte del `user` aunque
   * el prompt ya lleve las rutas: de un texto no se puede derivar una lista de
   * archivos, y el panel lateral necesita listarlos como entrada.
   */
  | { kind: 'attachment'; paths: string[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'delta'; text: string }
  | { kind: 'thinking' }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; toolUseId: string; text: string; isError: boolean }
  | { kind: 'permission'; request: PermissionRequestView }
  | { kind: 'permission_resolved'; id: string; decision: 'allow' | 'allow_always' | 'deny'; message?: string }
  | { kind: 'result'; costUsd: number; durationMs: number; numTurns: number; isError: boolean }
  | { kind: 'compacted'; preTokens: number }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; message: string }

export type StoredEvent = SessionEvent & { seq: number; ts: number }
