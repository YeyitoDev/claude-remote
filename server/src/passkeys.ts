import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { HttpError } from './auth.js'
import { config } from './config.js'
import type { User } from './types.js'

/**
 * Passkeys (WebAuthn) como segunda forma de entrar.
 *
 * El token sigue siendo la credencial de origen: sin él no hay forma de
 * registrar la primera passkey. Lo que aporta es dejar de depender de un
 * enlace que, si se pierde, obliga a rotar — con Face ID el acceso vive en el
 * llavero del dispositivo y se sincroniza por iCloud.
 *
 * Se guardan credenciales *descubribles* (`residentKey: required`): así al
 * entrar no hay que escribir ni elegir usuario, el propio dispositivo dice a
 * quién pertenece la passkey.
 */

export type Passkey = {
  id: string
  userId: string
  /** ID de la credencial en base64url, tal y como lo devuelve el autenticador. */
  credentialId: string
  publicKey: string
  counter: number
  transports: string[]
  label: string
  /** Dominio en el que se registró: una passkey solo vale en el suyo. */
  rpId: string
  createdAt: number
  lastUsedAt: number | null
}

const file = join(config.dataDir, 'passkeys.json')

function load(): Passkey[] {
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Passkey[]
  } catch (err) {
    console.error('[passkeys] archivo ilegible, se ignora:', err)
    return []
  }
}

function save(keys: Passkey[]) {
  const tmp = `${file}.tmp`
  // 0600 como `users.json`: son credenciales, aunque solo sean claves públicas.
  writeFileSync(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Retos pendientes, en memoria y con caducidad.
 *
 * No se persisten a propósito: un reto sirve para una ceremonia y punto, y
 * reiniciar el servidor debe invalidarlos todos.
 */
const CHALLENGE_TTL_MS = 3 * 60_000
const challenges = new Map<string, { challenge: string; expires: number }>()

function putChallenge(key: string, challenge: string) {
  challenges.set(key, { challenge, expires: Date.now() + CHALLENGE_TTL_MS })
}

function takeChallenge(key: string): string {
  const entry = challenges.get(key)
  challenges.delete(key)
  if (!entry || entry.expires < Date.now()) {
    throw new HttpError(400, 'El reto caducó. Vuelve a intentarlo.')
  }
  return entry.challenge
}

/** Limpieza perezosa: sin esto un reto abandonado se queda en memoria. */
function sweep() {
  const now = Date.now()
  for (const [key, entry] of challenges) if (entry.expires < now) challenges.delete(key)
}

// --------------------------------------------------------------- consultas

export function passkeysOf(userId: string): Passkey[] {
  return load().filter((k) => k.userId === userId)
}

export function passkeyView(key: Passkey) {
  return {
    id: key.id,
    label: key.label,
    rpId: key.rpId,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
  }
}

export function removePasskey(userId: string, id: string) {
  const keys = load()
  const next = keys.filter((k) => !(k.id === id && k.userId === userId))
  if (next.length === keys.length) throw new HttpError(404, 'Esa passkey no existe.')
  save(next)
}

// ------------------------------------------------------------- alta

export async function registrationOptions(user: User, rpId: string, origin: string) {
  sweep()
  const mine = passkeysOf(user.id)
  const options = await generateRegistrationOptions({
    rpName: 'Claude Remote',
    rpID: rpId,
    userID: user.id,
    userName: user.name,
    userDisplayName: user.name,
    attestationType: 'none',
    // Sin esto, volver a registrar en el mismo dispositivo crearía una passkey
    // duplicada en vez de avisar de que ya hay una.
    excludeCredentials: mine.map((k) => ({
      id: Buffer.from(k.credentialId, 'base64url'),
      type: 'public-key' as const,
      transports: k.transports as never,
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
  })

  putChallenge(`reg:${user.id}:${origin}`, options.challenge)
  return options
}

export async function verifyRegistration(
  user: User,
  body: { response: unknown; label?: string },
  rpId: string,
  origin: string,
) {
  const expectedChallenge = takeChallenge(`reg:${user.id}:${origin}`)

  const verification = await verifyRegistrationResponse({
    response: body.response as never,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
  })

  if (!verification.verified || !verification.registrationInfo) {
    throw new HttpError(400, 'No se pudo verificar la passkey.')
  }

  const { credentialID, credentialPublicKey, counter } = verification.registrationInfo
  const credentialId = Buffer.from(credentialID).toString('base64url')

  const keys = load()
  if (keys.some((k) => k.credentialId === credentialId)) {
    throw new HttpError(409, 'Esa passkey ya estaba registrada.')
  }

  const key: Passkey = {
    id: randomUUID(),
    userId: user.id,
    credentialId,
    publicKey: Buffer.from(credentialPublicKey).toString('base64url'),
    counter,
    transports: ((body.response as { transports?: string[] })?.transports ?? []) as string[],
    label: (body.label ?? '').trim() || 'Este dispositivo',
    rpId,
    createdAt: Date.now(),
    lastUsedAt: null,
  }
  keys.push(key)
  save(keys)
  return key
}

// ------------------------------------------------------------- entrada

export async function authenticationOptions(rpId: string, origin: string) {
  sweep()
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    userVerification: 'preferred',
    // Sin `allowCredentials` el dispositivo ofrece las passkeys que tenga para
    // este dominio: se entra sin decir quién eres.
  })
  putChallenge(`auth:${origin}`, options.challenge)
  return options
}

/** Devuelve el usuario dueño de la passkey, o lanza. */
export async function verifyAuthentication(
  response: unknown,
  rpId: string,
  origin: string,
): Promise<{ userId: string }> {
  const expectedChallenge = takeChallenge(`auth:${origin}`)

  const rawId = (response as { id?: string })?.id
  if (typeof rawId !== 'string' || !rawId) throw new HttpError(400, 'Respuesta de passkey inválida.')

  const keys = load()
  const key = keys.find((k) => k.credentialId === rawId)
  if (!key) throw new HttpError(404, 'Esa passkey no está registrada aquí.')

  const verification = await verifyAuthenticationResponse({
    response: response as never,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    authenticator: {
      credentialID: Buffer.from(key.credentialId, 'base64url'),
      credentialPublicKey: Buffer.from(key.publicKey, 'base64url'),
      counter: key.counter,
      transports: key.transports as never,
    },
  })

  if (!verification.verified) throw new HttpError(401, 'La passkey no verificó.')

  // El contador detecta credenciales clonadas. Las passkeys sincronizadas de
  // Apple lo dejan en 0 y nunca lo suben: por eso solo se guarda, no se exige.
  key.counter = verification.authenticationInfo.newCounter
  key.lastUsedAt = Date.now()
  save(keys)

  return { userId: key.userId }
}

/** Borra las passkeys de un usuario que se da de baja. */
export function removeAllFor(userId: string) {
  const keys = load()
  save(keys.filter((k) => k.userId !== userId))
}
