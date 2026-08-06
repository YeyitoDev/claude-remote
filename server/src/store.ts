import {
  appendFileSync,
  createReadStream,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { config } from './config.js'
import type { AccessLink, Project, StoredEvent, UsageRecord, User } from './types.js'

/**
 * Persistencia en archivos planos: JSON para las colecciones pequeñas
 * (usuarios, proyectos, sesiones) y JSONL append-only para lo que crece sin
 * techo (eventos, uso). Es inspeccionable con `cat` y no necesita servidor.
 */

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (err) {
    console.error(`[store] ${file} ilegible, se usa el valor por defecto:`, err)
    return fallback
  }
}

/** Escritura atómica: se escribe a .tmp y se renombra, así nunca queda medio archivo. */
function writeJsonAtomic(file: string, data: unknown, mode?: number) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined)
  renameSync(tmp, file)
}

/** Agrupa escrituras para no tocar el disco en cada evento. */
function debouncedWriter<T>(file: string, mode?: number) {
  let timer: NodeJS.Timeout | null = null
  let pending: T | null = null
  return (data: T) => {
    pending = data
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (pending !== null) writeJsonAtomic(file, pending, mode)
      pending = null
    }, 200)
  }
}

// ------------------------------------------------------------------ usuarios

export const loadUsers = () => readJson<User[]>(config.usersFile, [])
// 0600: el archivo contiene hashes de token, no debe ser legible por otros.
export const saveUsers = debouncedWriter<User[]>(config.usersFile, 0o600)

// ----------------------------------------------------------------- proyectos

export const loadProjects = () => readJson<Project[]>(config.projectsFile, [])
export const saveProjects = debouncedWriter<Project[]>(config.projectsFile)

// ------------------------------------------------------- enlaces de acceso

export const loadLinks = () => readJson<AccessLink[]>(config.linksFile, [])
export const saveLinks = debouncedWriter<AccessLink[]>(config.linksFile)

/**
 * `mtime` del archivo de enlaces, o 0 si no existe.
 *
 * El script `set-link` lo escribe desde fuera mientras el servidor corre —es
 * lo que hace `start.sh` al levantar el túnel—, así que la copia en memoria
 * tiene que poder darse cuenta en vez de pisarlo en la siguiente escritura.
 */
export function linksMtime(): number {
  try {
    return statSync(config.linksFile).mtimeMs
  } catch {
    return 0
  }
}

// ------------------------------------------------------------------ sesiones

export const loadSessions = <T>() => readJson<T[]>(config.sessionsFile, [])
export const saveSessions = debouncedWriter<unknown[]>(config.sessionsFile)

// -------------------------------------------------------------------- uso

export function appendUsage(record: UsageRecord) {
  appendFileSync(config.usageFile, JSON.stringify(record) + '\n')
}

export async function readUsage(filter?: { since?: number; userId?: string }): Promise<UsageRecord[]> {
  if (!existsSync(config.usageFile)) return []
  const out: UsageRecord[] = []
  const rl = createInterface({ input: createReadStream(config.usageFile), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    try {
      const rec = JSON.parse(line) as UsageRecord
      if (filter?.since && rec.ts < filter.since) continue
      if (filter?.userId && rec.userId !== filter.userId) continue
      out.push(rec)
    } catch {
      // línea corrupta: se salta
    }
  }
  rl.close()
  return out
}

// ------------------------------------------------------------------ eventos

const eventFile = (id: string) => join(config.eventsDir, `${id}.jsonl`)

export function appendEvent(sessionId: string, event: StoredEvent) {
  appendFileSync(eventFile(sessionId), JSON.stringify(event) + '\n')
}

export async function readEvents(sessionId: string, since: number, limit: number): Promise<StoredEvent[]> {
  const file = eventFile(sessionId)
  if (!existsSync(file)) return []
  const out: StoredEvent[] = []
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    try {
      const ev = JSON.parse(line) as StoredEvent
      if (ev.seq > since) out.push(ev)
    } catch {
      // línea corrupta: se salta
    }
  }
  rl.close()
  return out.slice(-limit)
}

/** Último `seq` escrito, sin cargar el archivo entero. */
export async function lastSeq(sessionId: string): Promise<number> {
  const file = eventFile(sessionId)
  if (!existsSync(file)) return 0
  let max = 0
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    try {
      const seq = (JSON.parse(line) as StoredEvent).seq
      if (seq > max) max = seq
    } catch {
      // línea corrupta: se salta
    }
  }
  rl.close()
  return max
}

export function deleteEvents(sessionId: string) {
  const file = eventFile(sessionId)
  if (existsSync(file)) writeFileSync(file, '')
}
