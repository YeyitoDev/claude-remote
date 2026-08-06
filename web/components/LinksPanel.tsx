'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { isLanOnly, isShareable } from '@/lib/invite'
import { useStore } from '@/lib/store'
import type { AccessLink } from '@/lib/types'
import { IconPlus, IconRefresh, IconTrash } from './Icons'
import { Sheet } from './Sheet'

type Probe = 'ok' | 'fail' | 'checking'

/**
 * Enlaces de acceso remoto. Un quick tunnel cambia de URL en cada arranque, así
 * que esto es lo que evita tener que regenerar invitaciones a mano cada vez:
 * se actualiza la dirección aquí y las invitaciones nuevas ya salen bien.
 */
export function LinksPanel() {
  const { conn, links, refresh, defaults } = useStore()
  const [editing, setEditing] = useState<AccessLink | 'new' | null>(null)
  const [probes, setProbes] = useState<Record<string, Probe>>({})
  const [failure, setFailure] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>) => {
    setFailure(null)
    try {
      await fn()
      await refresh()
    } catch (err: any) {
      setFailure(err?.message ?? 'Falló la operación.')
    }
  }

  /**
   * La comprobación la hace el navegador, no el servidor: así se prueba la
   * ruta que de verdad importa (la del cliente) y no se abre un SSRF pidiéndole
   * al servidor que visite una URL arbitraria.
   */
  const probe = async (link: AccessLink) => {
    setProbes((p) => ({ ...p, [link.id]: 'checking' }))
    try {
      const res = await fetch(`${link.url}/api/health`, { signal: AbortSignal.timeout(8000) })
      setProbes((p) => ({ ...p, [link.id]: res.ok ? 'ok' : 'fail' }))
    } catch {
      setProbes((p) => ({ ...p, [link.id]: 'fail' }))
    }
  }

  return (
    <div className="scroll pad">
      <button className="btn primary block" onClick={() => setEditing('new')}>
        <span className="row-center">
          <IconPlus /> Añadir enlace de acceso
        </span>
      </button>

      {failure && <div className="notice error">{failure}</div>}

      {!links.length && (
        <div className="notice warn">
          No hay ninguno. Las invitaciones usarán el origen desde el que navegas, que puede ser{' '}
          <code className="inline-code">{defaults?.localUrl}</code> y no servirle a nadie de fuera.
        </div>
      )}

      <div className="stack">
        {links.map((link) => (
          <div key={link.id} className="panel link-card">
            <div className="link-head">
              <span className="link-label">{link.label}</span>
              {link.primary && <span className="chip on">principal</span>}
              {isLanOnly(link.url) && <span className="chip">solo LAN</span>}
              {!isShareable(link.url) && <span className="chip bloqueado">no repartible</span>}
              {probes[link.id] === 'ok' && <span className="chip creado">responde</span>}
              {probes[link.id] === 'fail' && <span className="chip bloqueado">sin respuesta</span>}
            </div>
            <div className="field-hint mono">{link.url}</div>
            {link.note && <div className="field-hint">{link.note}</div>}

            <div className="link-actions">
              <button className="btn ghost" onClick={() => void probe(link)}>
                <span className="row-center">
                  <IconRefresh /> {probes[link.id] === 'checking' ? 'Probando…' : 'Probar'}
                </span>
              </button>
              <button className="btn ghost" onClick={() => setEditing(link)}>
                Editar
              </button>
              {!link.primary && (
                <button
                  className="btn ghost"
                  onClick={() => conn && run(() => api.updateLink(conn, link.id, { primary: true }))}
                >
                  Hacer principal
                </button>
              )}
              <button
                className="btn danger"
                onClick={() => conn && run(() => api.deleteLink(conn, link.id))}
                aria-label="Borrar"
              >
                <IconTrash />
              </button>
            </div>
          </div>
        ))}
      </div>

      <span className="field-hint">
        Los quick tunnels de Cloudflare cambian de URL en cada arranque: actualiza aquí la dirección y las
        invitaciones nuevas saldrán correctas. Las ya repartidas apuntan a la URL vieja y dejan de funcionar.
      </span>

      {editing && (
        <LinkSheet
          link={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSubmit={async (body) => {
            if (!conn) return
            await run(() =>
              editing === 'new' ? api.createLink(conn, body) : api.updateLink(conn, editing.id, body),
            )
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function LinkSheet({
  link,
  onClose,
  onSubmit,
}: {
  link: AccessLink | null
  onClose: () => void
  onSubmit: (body: { label?: string; url: string; note?: string; primary?: boolean }) => Promise<void>
}) {
  const { defaults } = useStore()
  const [url, setUrl] = useState(link?.url ?? '')
  const [label, setLabel] = useState(link?.label ?? '')
  const [note, setNote] = useState(link?.note ?? '')
  const [primary, setPrimary] = useState(link?.primary ?? false)
  const [busy, setBusy] = useState(false)

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <Sheet title={link ? 'Editar enlace' : 'Nuevo enlace de acceso'} onClose={onClose}>
      <div className="field">
        <label htmlFor="l-url">Dirección</label>
        <input
          id="l-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://algo.trycloudflare.com"
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="url"
        />
        <span className="field-hint">Se guarda solo el origen; la ruta la pone la app.</span>
        {currentOrigin && currentOrigin !== url && (
          <button className="btn ghost block" onClick={() => setUrl(currentOrigin)}>
            Usar por la que entré: {currentOrigin.replace(/^https?:\/\//, '')}
          </button>
        )}
        {defaults?.localUrl && defaults.localUrl !== url && (
          <button className="btn ghost block" onClick={() => setUrl(defaults.localUrl)}>
            Usar la local: {defaults.localUrl}
          </button>
        )}
      </div>

      <div className="field">
        <label htmlFor="l-label">Etiqueta</label>
        <input
          id="l-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="opcional — se deduce del dominio"
        />
      </div>

      <div className="field">
        <label htmlFor="l-note">Nota</label>
        <input
          id="l-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="opcional — p. ej. «solo mientras esté el portátil encendido»"
        />
      </div>

      <div className="field">
        <label>Principal</label>
        <div className="seg">
          <button className={primary ? 'on' : ''} onClick={() => setPrimary(true)}>
            Sí
          </button>
          <button className={!primary ? 'on' : ''} onClick={() => setPrimary(false)}>
            No
          </button>
        </div>
        <span className="field-hint">El principal es el que se propone al generar invitaciones.</span>
      </div>

      <button
        className="btn primary block"
        disabled={busy || !url.trim()}
        onClick={async () => {
          setBusy(true)
          await onSubmit({ url: url.trim(), label: label.trim(), note: note.trim(), primary })
          setBusy(false)
        }}
      >
        {busy ? 'Guardando…' : 'Guardar'}
      </button>
    </Sheet>
  )
}
