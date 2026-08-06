'use client'

import { useMemo, useState } from 'react'
import { buildInviteLink, buildInviteMessage, isLanOnly, isShareable } from '@/lib/invite'
import { useStore } from '@/lib/store'
import { IconCopy, IconShare } from './Icons'

type Copied = 'link' | 'message' | null

/**
 * Bloque de compartir reutilizable: lo usa el admin para invitar a alguien y
 * cualquier usuario para llevarse su propio acceso a otro dispositivo.
 *
 * `navigator.share` solo existe en HTTPS y en móvil; el botón se muestra
 * siempre y cae a copiar el mensaje completo cuando no está disponible, porque
 * un botón que aparece y desaparece según el dispositivo confunde más que ayuda.
 */
export function ShareInvite({ token, name, from }: { token: string; name?: string; from?: string }) {
  const { conn, links } = useStore()
  const [copied, setCopied] = useState<Copied>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [pick, setPick] = useState<string | null>(null)

  // Sin enlaces registrados se cae al origen actual, que puede ser localhost.
  const chosen = links.find((l) => l.id === pick) ?? links.find((l) => l.primary) ?? links[0] ?? null
  const link = useMemo(
    () => (conn ? buildInviteLink(conn, token, chosen?.url) : ''),
    [conn, token, chosen?.url],
  )
  const message = buildInviteMessage({ link, name, from })
  const usable = isShareable(link)

  const copy = async (value: string, what: Exclude<Copied, null>) => {
    setFailure(null)
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
    } catch {
      setFailure('El navegador no dejó copiar. Mantén pulsado el texto de arriba y cópialo a mano.')
    }
  }

  const share = async () => {
    if (typeof navigator === 'undefined' || !('share' in navigator)) {
      return copy(message.full, 'message')
    }
    try {
      await navigator.share({ title: message.title, text: message.text, url: link })
    } catch (err: any) {
      // Cancelar el diálogo no es un fallo que haya que reportar.
      if (err?.name !== 'AbortError') void copy(message.full, 'message')
    }
  }

  return (
    <>
      {links.length > 1 && (
        <div className="field">
          <label>Por qué dirección</label>
          <div className="seg">
            {links.map((l) => (
              <button key={l.id} className={chosen?.id === l.id ? 'on' : ''} onClick={() => setPick(l.id)}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!usable && (
        <div className="notice error">
          El enlace apunta a una dirección local: solo funcionará en esta máquina. Registra un enlace de acceso
          remoto en Administración → Enlaces.
        </div>
      )}
      {usable && chosen && isLanOnly(chosen.url) && (
        <div className="notice warn">
          Esa dirección es de tu red local: funciona en casa, no desde fuera.
        </div>
      )}

      <div className="field">
        <label>Mensaje</label>
        <div className="share-preview">{message.full}</div>
      </div>

      <button className="btn primary block" onClick={() => void share()}>
        <span className="row-center">
          <IconShare /> {copied === 'message' ? 'Mensaje copiado' : 'Compartir invitación'}
        </span>
      </button>

      <button className="btn block" onClick={() => void copy(link, 'link')}>
        <span className="row-center">
          <IconCopy /> {copied === 'link' ? 'Enlace copiado' : 'Copiar solo el enlace'}
        </span>
      </button>

      {failure && <div className="notice error">{failure}</div>}
    </>
  )
}
