'use client'

import { useEffect, useState } from 'react'
import { normalizeUrl } from '@/lib/api'
import { loginWithPasskey, passkeyError, passkeysUsable, secureEnough } from '@/lib/passkey'
import { useStore } from '@/lib/store'
import { IconKey } from './Icons'

/** Si la PWA se sirve desde el propio servidor, el origen ya es la respuesta correcta. */
function guessUrl(): string {
  if (typeof window === 'undefined') return ''
  const { origin, port } = window.location
  // 3111 es el dev server de Next: ahí el servidor está en otro puerto.
  return port === '3111' ? '' : origin
}

export function ConnectScreen() {
  const { connect, error } = useStore()
  const [url, setUrl] = useState(guessUrl)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [canPasskey, setCanPasskey] = useState(false)

  // En un efecto: el HTML es estático y consultar el autenticador durante el
  // render rompería la hidratación.
  useEffect(() => {
    void passkeysUsable().then(setCanPasskey)
  }, [])

  const withPasskey = async () => {
    const normalized = normalizeUrl(url)
    if (!normalized) {
      setLocalError('Falta la dirección del servidor.')
      return
    }
    setBusy(true)
    setLocalError(null)
    try {
      await connect(await loginWithPasskey(normalized))
    } catch (err: any) {
      setLocalError(passkeyError(err))
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    const normalized = normalizeUrl(url)
    if (!normalized || !token.trim()) {
      setLocalError('Faltan la dirección o el token.')
      return
    }
    setBusy(true)
    setLocalError(null)
    try {
      await connect({ url: normalized, token: token.trim() })
    } catch (err: any) {
      setLocalError(err?.message ?? 'No se pudo conectar.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="connect">
      <div className="connect-card">
        <h1>Claude Remote</h1>
        <p>Pega el token que te dio el administrador. Queda guardado en este dispositivo.</p>

        <div className="field">
          <label htmlFor="url">Servidor</label>
          <input
            id="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://tu-tunel.trycloudflare.com"
            autoCapitalize="none"
            autoCorrect="off"
            inputMode="url"
          />
        </div>

        <div className="field">
          <label htmlFor="token">Token de acceso</label>
          <input
            id="token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="pegar token"
            autoCapitalize="none"
            autoCorrect="off"
            type="password"
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </div>

        {(localError || error) && <div className="notice error">{localError || error}</div>}

        <button className="btn primary block" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>

        {canPasskey && (
          <>
            <div className="or">o</div>
            <button
              className="btn block"
              onClick={() => void withPasskey()}
              disabled={busy || !secureEnough(url)}
            >
              <span className="row-center">
                <IconKey size={16} /> Entrar con Face ID o Touch ID
              </span>
            </button>
            <span className="field-hint">
              {secureEnough(url)
                ? 'Solo si ya registraste una passkey desde este servidor. La primera vez entra con el token y añádela en Mi cuenta.'
                : 'Las passkeys necesitan una dirección https (o localhost). Por la IP de la red local el navegador no las permite.'}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
