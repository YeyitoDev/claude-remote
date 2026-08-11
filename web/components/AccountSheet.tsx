'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { formatCost, relativeTime } from '@/lib/items'
import { passkeyError, passkeysUsable, registerPasskey, secureEnough } from '@/lib/passkey'
import { useStore } from '@/lib/store'
import type { DeviceView, PasskeyView } from '@/lib/types'
import { IconKey, IconLogout, IconTrash } from './Icons'
import { ShareInvite } from './ShareInvite'
import { Sheet } from './Sheet'

/**
 * Cuenta propia. El enlace se arma con el token que la app ya tiene en memoria,
 * así que abrir tu acceso en otro dispositivo no pasa por el servidor ni crea
 * credenciales nuevas: es el mismo token.
 */
export function AccountSheet({ onClose }: { onClose: () => void }) {
  const { me, conn, defaults, disconnect } = useStore()
  if (!me || !conn) return null

  const limit = me.limits.monthlyUsd

  return (
    <Sheet title={me.name} onClose={onClose}>
      <div className="field">
        <label>Consumo del mes</label>
        <span className="field-hint">
          {formatCost(me.usage.monthUsd)}
          {limit != null ? ` de ${formatCost(limit)}` : ' · sin tope'} · {me.usage.monthTurns} turnos ·{' '}
          {me.projectCount} proyectos
        </span>
        {limit != null && (
          <span className="usage-bar wide" aria-hidden>
            <i
              style={{ width: `${Math.min(100, Math.round((me.usage.monthUsd / limit) * 100))}%` }}
              className={me.usage.monthUsd / limit > 0.85 ? 'hot' : ''}
            />
          </span>
        )}
      </div>

      <div className="field">
        <label>Abrir en otro dispositivo</label>
        <span className="field-hint">
          Mándate este enlace y ábrelo en la tablet o el portátil: entra directo con tu misma cuenta.
        </span>
      </div>

      <ShareInvite token={conn.token} />

      <PasskeyPanel />

      <div className="field">
        <label>Servidor</label>
        <span className="field-hint mono">{conn.url}</span>
        {defaults && <span className="field-hint mono">{defaults.workspace}</span>}
      </div>

      <button
        className="btn ghost block"
        onClick={() => {
          disconnect()
          onClose()
        }}
      >
        <span className="row-center">
          <IconLogout /> Cerrar sesión en este dispositivo
        </span>
      </button>
    </Sheet>
  )
}

/**
 * Passkeys de la cuenta.
 *
 * Registrar una es lo que convierte este dispositivo en una llave: a partir de
 * ahí se entra con Face ID y deja de hacer falta guardar el enlace en ningún
 * sitio. Se registra desde dentro a propósito — el token sigue siendo la
 * credencial de origen.
 */
function PasskeyPanel() {
  const { conn } = useStore()
  const [usable, setUsable] = useState(false)
  const [passkeys, setPasskeys] = useState<PasskeyView[]>([])
  const [devices, setDevices] = useState<DeviceView[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    void passkeysUsable().then(setUsable)
  }, [])

  const load = useCallback(async () => {
    if (!conn) return
    try {
      const res = await api.passkeys(conn)
      setPasskeys(res.passkeys)
      setDevices(res.devices)
    } catch {
      /* sin passkeys todavía, o servidor antiguo */
    }
  }, [conn])

  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    if (!conn) return
    setBusy(true)
    setFailure(null)
    setDone(false)
    try {
      await registerPasskey(conn)
      setDone(true)
      await load()
    } catch (err) {
      setFailure(passkeyError(err))
    } finally {
      setBusy(false)
    }
  }

  const run = async (fn: () => Promise<unknown>) => {
    setFailure(null)
    try {
      await fn()
      await load()
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo.')
    }
  }

  if (!usable) return null
  const allowed = secureEnough(conn?.url)

  return (
    <div className="field">
      <label>Passkeys</label>
      <span className="field-hint">
        Entra con Face ID o Touch ID en vez de con el enlace. Se guarda en el llavero del dispositivo y se
        sincroniza con tus otros equipos por iCloud.
      </span>

      {passkeys.map((key) => (
        <div key={key.id} className="file-row">
          <span className="file-main">
            <IconKey />
            <span className="file-text">
              <span className="file-name">{key.label}</span>
              <span className="file-path">{key.rpId}</span>
              <span className="file-meta">
                creada {relativeTime(key.createdAt)} · usada {relativeTime(key.lastUsedAt)}
              </span>
            </span>
          </span>
          <button
            className="icon-button danger"
            onClick={() => void run(() => api.deletePasskey(conn!, key.id))}
            aria-label={`Borrar ${key.label}`}
          >
            <IconTrash size={15} />
          </button>
        </div>
      ))}

      {devices.length > 0 && (
        <>
          <span className="field-hint">
            Dispositivos que entraron con passkey. Revocar uno lo desconecta sin tocar a los demás.
          </span>
          {devices.map((device) => (
            <div key={device.id} className="file-row">
              <span className="file-main">
                <span className="file-text">
                  <span className="file-name">{device.label}</span>
                  <span className="file-meta">
                    {device.tokenHint}… · entró {relativeTime(device.createdAt)} · visto{' '}
                    {relativeTime(device.lastUsedAt)}
                  </span>
                </span>
              </span>
              <button
                className="icon-button danger"
                onClick={() => void run(() => api.deleteDevice(conn!, device.id))}
                aria-label={`Revocar ${device.label}`}
              >
                <IconTrash size={15} />
              </button>
            </div>
          ))}
        </>
      )}

      {failure && <div className="notice error">{failure}</div>}
      {done && <div className="notice">Passkey añadida. Ya puedes entrar con ella.</div>}

      <button className="btn block" onClick={() => void add()} disabled={busy || !allowed}>
        <span className="row-center">
          <IconKey size={16} /> {busy ? 'Esperando al dispositivo…' : 'Añadir passkey'}
        </span>
      </button>

      {!allowed && (
        <span className="field-hint">
          Estás conectado por una dirección sin https, y ahí el navegador no permite passkeys. Entra por la
          dirección pública para añadirla.
        </span>
      )}
    </div>
  )
}
