export type Role = 'admin' | 'user'

export type Limits = {
  monthlyUsd: number | null
  maxProjects: number | null
  maxLiveSessions: number | null
}

export type UsageSummary = {
  monthUsd: number
  monthTurns: number
  totalUsd: number
  totalTurns: number
}

export type UserView = {
  id: string
  name: string
  role: Role
  tokenHint: string
  disabled: boolean
  limits: Limits
  createdAt: number
  lastSeenAt: number | null
  usage: UsageSummary
  projectCount: number
}

export type AccessLink = {
  id: string
  label: string
  url: string
  note: string
  primary: boolean
  createdAt: number
}

export type ModelRoles = {
  main: string
  plan: string | null
  rules: string | null
  knowledge: string | null
}

export type ProjectView = {
  id: string
  slug: string
  name: string
  description: string
  ownerId: string
  ownerName: string
  dir: string
  createdAt: number
  updatedAt: number
  summary: string | null
  summaryUpdatedAt: number | null
  autoKnowledge: boolean
  knowledgeEntries: number
  models: ModelRoles
  rules: string
  autoApprove: boolean
  sessionCount: number
  liveSessionCount: number
  lastActivityAt: number | null
}

export type PasskeyView = {
  id: string
  label: string
  /** Dominio donde se registró: una passkey solo vale en el suyo. */
  rpId: string
  createdAt: number
  lastUsedAt: number | null
}

/** Un dispositivo que entró con passkey y tiene su propio token. */
export type DeviceView = {
  id: string
  label: string
  tokenHint: string
  createdAt: number
  lastUsedAt: number | null
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

export type FileKind = 'markdown' | 'text' | 'image' | 'pdf' | 'docx' | 'binary'

export type FileView = {
  path: string
  name: string
  kind: FileKind
  size: number
  mtimeMs: number
  mime: string
  content: string | null
  truncated: boolean
}

export type KnowledgeEntry = {
  date: string
  time: string
  sessionId: string
  sessionTitle: string
  userName: string
  content: string
  ts: number
  manual: boolean
}

export type KnowledgeView = {
  summary: string | null
  summaryUpdatedAt: number | null
  days: { date: string; entries: KnowledgeEntry[] }[]
  totalEntries: number
}

export type UsageRecordView = {
  ts: number
  userId: string
  userName: string
  projectId: string | null
  projectName: string | null
  sessionId: string | null
  model: string
  costUsd: number
  durationMs: number
  numTurns: number
  kind: 'session' | 'knowledge' | 'rules'
}

export type SessionStatus = 'dormant' | 'starting' | 'idle' | 'busy' | 'awaiting_permission' | 'error'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions' | 'auto'

export type PermissionRequestView = {
  id: string
  toolName: string
  title: string
  description: string | null
  input: Record<string, unknown>
  suggestionCount: number
  createdAt: number
}

export type SessionView = {
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
  knowledgeSeq: number
  status: SessionStatus
  seq: number
  pendingPermissions: PermissionRequestView[]
  preview: string | null
}

export type SessionEvent =
  | { kind: 'status'; status: SessionStatus }
  | { kind: 'user'; text: string }
  /** Archivos que subió el usuario para ese turno. Los lista el panel lateral. */
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

export type Defaults = { model: string; workspace: string; maxLive: number; localUrl: string }

export type Snapshot = {
  me: UserView
  projects: ProjectView[]
  sessions: SessionView[]
  limits: Limits
  links: AccessLink[]
  defaults: Defaults
}

/** Item ya listo para pintar: los eventos crudos se pliegan en estas tarjetas. */
export type Item =
  | { type: 'user'; key: string; ts: number; text: string }
  | { type: 'assistant'; key: string; ts: number; text: string }
  | { type: 'thinking'; key: string; ts: number }
  | {
      type: 'tool'
      key: string
      ts: number
      toolUseId: string
      name: string
      input: Record<string, unknown>
      result: string | null
      isError: boolean
    }
  | {
      type: 'permission'
      key: string
      ts: number
      request: PermissionRequestView
      decision: 'allow' | 'allow_always' | 'deny' | null
    }
  | {
      type: 'result'
      key: string
      ts: number
      costUsd: number
      durationMs: number
      isError: boolean
      /** Archivos que dejó el turno, en rutas absolutas tal cual las dio la herramienta. */
      produced: string[]
    }
  | { type: 'compacted'; key: string; ts: number; preTokens: number }
  | { type: 'notice'; key: string; ts: number; text: string; tone: 'info' | 'error' }
