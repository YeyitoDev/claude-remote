import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { config } from './config.js'
import { loadDevices, loadUsers, saveDevices, saveUsers } from './store.js'
import type { DeviceToken, Limits, Role, User } from './types.js'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Autenticación por token revocable, uno por usuario.
 *
 * En disco solo vive el SHA-256 del token: si alguien lee `users.json` no
 * obtiene credenciales usables. El token en claro se muestra una única vez al
 * crearlo o rotarlo; si se pierde, se rota.
 */
export class Auth {
  private users: User[]
  /** hash → usuario. La búsqueda por hash hace irrelevante el timing. */
  private byHash = new Map<string, User>()

  /**
   * Tokens emitidos al entrar con passkey, uno por dispositivo.
   *
   * Van aparte del token del usuario para que perder el móvil se resuelva
   * revocando ese dispositivo, sin echar a los demás — que es justo lo que
   * pasaba cuando la única credencial era una y compartida.
   */
  private devices: DeviceToken[]
  private byDeviceHash = new Map<string, DeviceToken>()

  constructor() {
    this.users = loadUsers()
    this.devices = loadDevices<DeviceToken>()
    this.reindex()
  }

  /** Crea el admin en el primer arranque y devuelve su token en claro. */
  bootstrap(): { user: User; token: string } | null {
    if (this.users.length) return null
    const token = config.bootstrapToken || generateToken()
    const user = this.insert({ name: 'admin', role: 'admin', token, limits: unlimited() })
    return { user, token }
  }

  private reindex() {
    this.byHash = new Map(this.users.map((u) => [u.tokenHash, u]))
    this.byDeviceHash = new Map(this.devices.map((d) => [d.tokenHash, d]))
  }

  private persist() {
    this.reindex()
    saveUsers(this.users)
  }

  private insert(input: { name: string; role: Role; token: string; limits: Limits }): User {
    const user: User = {
      id: randomUUID(),
      name: input.name,
      role: input.role,
      tokenHash: hashToken(input.token),
      tokenHint: input.token.slice(0, 6),
      disabled: false,
      limits: input.limits,
      createdAt: Date.now(),
      lastSeenAt: null,
    }
    this.users.push(user)
    this.persist()
    return user
  }

  list(): User[] {
    return [...this.users].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): User | undefined {
    return this.users.find((u) => u.id === id)
  }

  /** Devuelve el usuario del token, o null. Marca `lastSeenAt`. */
  resolve(token: string | undefined): User | null {
    if (!token) return null
    const hash = hashToken(token)

    // Primero el token del usuario; si no, uno de dispositivo (passkey).
    let user = this.byHash.get(hash)
    let device: DeviceToken | undefined
    if (!user) {
      device = this.byDeviceHash.get(hash)
      if (device) user = this.get(device.userId)
    }
    if (!user || user.disabled) return null

    const now = Date.now()
    // Se persiste como mucho una vez por minuto para no escribir en cada request.
    if (!user.lastSeenAt || now - user.lastSeenAt > 60_000) {
      user.lastSeenAt = now
      if (device) device.lastUsedAt = now
      this.persist()
    }
    return user
  }

  // ------------------------------------------------- tokens de dispositivo

  /** Emite el token que usará este dispositivo tras entrar con passkey. */
  issueDeviceToken(userId: string, label: string): string {
    const token = generateToken()
    this.devices.push({
      id: randomUUID(),
      userId,
      tokenHash: hashToken(token),
      tokenHint: token.slice(0, 6),
      label: label.trim() || 'Dispositivo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    this.persistDevices()
    return token
  }

  devicesOf(userId: string): DeviceToken[] {
    return this.devices.filter((d) => d.userId === userId).sort((a, b) => b.createdAt - a.createdAt)
  }

  revokeDevice(userId: string, id: string) {
    const before = this.devices.length
    this.devices = this.devices.filter((d) => !(d.id === id && d.userId === userId))
    if (this.devices.length === before) throw new HttpError(404, 'Ese dispositivo no existe.')
    this.persistDevices()
  }

  /** Al rotar el token o dar de baja al usuario, sus dispositivos caen con él. */
  revokeAllDevices(userId: string) {
    this.devices = this.devices.filter((d) => d.userId !== userId)
    this.persistDevices()
  }

  private persistDevices() {
    this.reindex()
    saveDevices(this.devices)
  }

  create(input: { name: string; role?: Role; limits?: Partial<Limits> }): { user: User; token: string } {
    const name = input.name.trim()
    if (!name) throw new HttpError(400, 'El nombre es obligatorio.')
    if (this.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, `Ya existe un usuario llamado "${name}".`)
    }
    const token = generateToken()
    const role = input.role === 'admin' ? 'admin' : 'user'
    const limits: Limits = {
      ...(role === 'admin' ? unlimited() : config.defaultLimits),
      ...cleanLimits(input.limits),
    }
    return { user: this.insert({ name, role, token, limits }), token }
  }

  update(id: string, patch: { name?: string; role?: Role; disabled?: boolean; limits?: Partial<Limits> }): User {
    const user = this.get(id)
    if (!user) throw new HttpError(404, 'Usuario no encontrado.')

    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw new HttpError(400, 'El nombre no puede quedar vacío.')
      if (this.users.some((u) => u.id !== id && u.name.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(409, `Ya existe un usuario llamado "${name}".`)
      }
      user.name = name
    }
    if (patch.role !== undefined) {
      if (user.role === 'admin' && patch.role !== 'admin' && this.adminCount() === 1) {
        throw new HttpError(400, 'No puedes quitar el último administrador.')
      }
      user.role = patch.role
    }
    if (patch.disabled !== undefined) {
      if (patch.disabled && user.role === 'admin' && this.activeAdminCount() === 1) {
        throw new HttpError(400, 'No puedes desactivar el último administrador activo.')
      }
      user.disabled = patch.disabled
    }
    if (patch.limits) user.limits = { ...user.limits, ...cleanLimits(patch.limits) }

    this.persist()
    return user
  }

  /** Invalida el token anterior y devuelve el nuevo en claro, una sola vez. */
  rotate(id: string): { user: User; token: string } {
    const user = this.get(id)
    if (!user) throw new HttpError(404, 'Usuario no encontrado.')
    const token = generateToken()
    user.tokenHash = hashToken(token)
    user.tokenHint = token.slice(0, 6)
    this.persist()
    return { user, token }
  }

  remove(id: string) {
    const user = this.get(id)
    if (!user) return
    if (user.role === 'admin' && this.adminCount() === 1) {
      throw new HttpError(400, 'No puedes borrar el último administrador.')
    }
    this.users = this.users.filter((u) => u.id !== id)
    this.persist()
  }

  private adminCount() {
    return this.users.filter((u) => u.role === 'admin').length
  }

  private activeAdminCount() {
    return this.users.filter((u) => u.role === 'admin' && !u.disabled).length
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function generateToken(): string {
  return randomBytes(24).toString('base64url')
}

function unlimited(): Limits {
  return { monthlyUsd: null, maxProjects: null, maxLiveSessions: null }
}

/** Normaliza límites: número positivo, o null para "sin límite". */
function cleanLimits(limits: Partial<Limits> | undefined): Partial<Limits> {
  if (!limits) return {}
  const out: Partial<Limits> = {}
  for (const key of ['monthlyUsd', 'maxProjects', 'maxLiveSessions'] as const) {
    if (!(key in limits)) continue
    const value = limits[key]
    if (value === null || value === undefined || value === ('' as unknown)) out[key] = null
    else {
      const n = Number(value)
      out[key] = Number.isFinite(n) && n >= 0 ? n : null
    }
  }
  return out
}
