import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const DATA_DIR = process.env.CR_DATA_DIR || join(homedir(), '.claude-remote')

/**
 * Raíz única donde viven las carpetas de proyecto. Los usuarios no eligen
 * rutas: crean proyectos y el servidor decide dónde van. Todo lo que quede
 * fuera de este árbol es inalcanzable desde la app.
 */
const WORKSPACE = resolve(process.env.CR_WORKSPACE || join(homedir(), 'claude-remote-workspace'))

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(join(DATA_DIR, 'events'), { recursive: true })
mkdirSync(WORKSPACE, { recursive: true })

export const config = {
  dataDir: DATA_DIR,
  eventsDir: join(DATA_DIR, 'events'),
  usersFile: join(DATA_DIR, 'users.json'),
  projectsFile: join(DATA_DIR, 'projects.json'),
  sessionsFile: join(DATA_DIR, 'sessions.json'),
  usageFile: join(DATA_DIR, 'usage.jsonl'),
  linksFile: join(DATA_DIR, 'links.json'),
  /** Tokens que emite una passkey al entrar: uno por dispositivo. */
  devicesFile: join(DATA_DIR, 'devices.json'),
  workspace: WORKSPACE,

  port: Number(process.env.CR_PORT || 8787),
  host: process.env.CR_HOST || '0.0.0.0',

  /** Token del admin en el primer arranque. Si no se define, se genera uno. */
  bootstrapToken: process.env.CR_TOKEN || null,

  defaultModel: process.env.CR_DEFAULT_MODEL || 'claude-opus-5',
  /** Modelo barato para resumir knowledge; nunca toca herramientas. */
  knowledgeModel: process.env.CR_KNOWLEDGE_MODEL || 'claude-haiku-4-5',

  /** Procesos del CLI vivos a la vez en toda la instalación. */
  maxLive: Number(process.env.CR_MAX_LIVE || 8),
  idleHibernateMs: Number(process.env.CR_IDLE_HIBERNATE_MS || 0),
  memoryEventCap: Number(process.env.CR_MEMORY_EVENT_CAP || 1500),

  /** Espera mínima entre entradas de knowledge de una misma sesión. */
  knowledgeDebounceMs: Number(process.env.CR_KNOWLEDGE_DEBOUNCE_MS || 60_000),

  defaultLimits: {
    monthlyUsd: numberOrNull(process.env.CR_DEFAULT_MONTHLY_USD, 20),
    maxProjects: numberOrNull(process.env.CR_DEFAULT_MAX_PROJECTS, 10),
    maxLiveSessions: numberOrNull(process.env.CR_DEFAULT_MAX_LIVE_SESSIONS, 3),
  },
}

function numberOrNull(raw: string | undefined, fallback: number | null): number | null {
  if (raw === undefined) return fallback
  if (raw === '' || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'sin') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export type Config = typeof config
