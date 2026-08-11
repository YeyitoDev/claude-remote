'use client'

import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser'
import { api, normalizeUrl, type Connection } from './api'

/**
 * Passkeys: entrar con Face ID o Touch ID en vez de con el enlace.
 *
 * El token sigue siendo la credencial de origen — la primera passkey se
 * registra ya dentro. Lo que cambia es lo de después: la credencial pasa a
 * vivir en el llavero del dispositivo, se sincroniza por iCloud entre el Mac y
 * el móvil, y deja de haber un enlace que perder.
 */

/** Nombre con el que se listará este dispositivo. Aproximado a propósito. */
export function deviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Dispositivo'
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  return 'Dispositivo'
}

/**
 * WebAuthn exige contexto seguro: HTTPS, o localhost.
 *
 * Merece comprobarlo antes de ofrecer el botón, porque por la IP de la LAN en
 * claro el navegador simplemente no expone la API y el fallo sería mudo.
 */
export function secureEnough(url?: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const target = new URL(url ? normalizeUrl(url) : window.location.href)
    return target.protocol === 'https:' || target.hostname === 'localhost' || target.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

export async function passkeysUsable(): Promise<boolean> {
  if (!browserSupportsWebAuthn()) return false
  try {
    return await platformAuthenticatorIsAvailable()
  } catch {
    return false
  }
}

/** Entra sin token: el dispositivo elige la passkey de este dominio. */
export async function loginWithPasskey(url: string): Promise<Connection> {
  const { options } = await api.passkeyLoginOptions(url)
  const response = await startAuthentication(options as never)
  const { token } = await api.passkeyLogin(url, response, deviceLabel())
  return { url: normalizeUrl(url), token }
}

/** Registra una passkey para la cuenta con la que ya estás dentro. */
export async function registerPasskey(conn: Connection): Promise<void> {
  const { options } = await api.passkeyRegisterOptions(conn)
  const response = await startRegistration(options as never)
  await api.passkeyRegister(conn, response, deviceLabel())
}

/**
 * Traduce los errores de WebAuthn a algo accionable.
 *
 * El navegador lanza `NotAllowedError` tanto si cancelas como si caduca el
 * tiempo, y tal cual no le dice nada a nadie.
 */
export function passkeyError(err: unknown): string {
  const name = (err as { name?: string })?.name
  const message = (err as { message?: string })?.message ?? ''

  if (name === 'NotAllowedError') return 'Se canceló o caducó. Inténtalo otra vez.'
  if (name === 'InvalidStateError') return 'Este dispositivo ya tiene una passkey para esta cuenta.'
  if (name === 'SecurityError') return 'El dominio no permite passkeys aquí. Entra por la dirección https.'
  if (name === 'AbortError') return 'Se interrumpió.'
  if (message.includes('not registered')) return 'Esa passkey no está registrada en este servidor.'
  return message || 'No se pudo usar la passkey.'
}
