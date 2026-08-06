'use client'

import { useEffect, useRef, useState } from 'react'
import { formatCost, shortPath, statusLabel } from '@/lib/items'
import { MODELS, MODES } from '@/lib/models'
import { useStore } from '@/lib/store'
import type { SessionView as Session } from '@/lib/types'
import { useDesktop, useDockedPreference } from '@/lib/useDesktop'
import { Composer } from './Composer'
import { Conversation } from './Conversation'
import { IconBack, IconChevronRight, IconPanelLeft, IconSettings, IconTrash } from './Icons'
import { SessionSidebar } from './SessionSidebar'
import { Sheet } from './Sheet'

export function SessionView({ sessionId }: { sessionId: string }) {
  const { sessions, projects, back, openSession, connState } = useStore()
  const [settings, setSettings] = useState(false)
  const [switcher, setSwitcher] = useState(false)
  const [drawer, setDrawer] = useState(false)

  const desktop = useDesktop()
  const [docked, setDocked] = useDockedPreference()

  // En escritorio el panel vive fijo al lado; en móvil se superpone.
  const sidebarVisible = desktop ? docked : drawer
  const toggleSidebar = () => (desktop ? setDocked(!docked) : setDrawer(!drawer))
  useEdgeSwipe(!desktop, setDrawer)

  const session = sessions.find((s) => s.id === sessionId)

  if (!session) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="topbar-row">
            <button className="icon-button" onClick={back} aria-label="Atrás">
              <IconBack />
            </button>
            <div className="session-button-text">
              <span className="session-title">Sesión no encontrada</span>
            </div>
          </div>
        </header>
        <div className="empty">
          <div className="empty-inner">Puede que la hayan borrado.</div>
        </div>
        <div />
      </div>
    )
  }

  const project = projects.find((p) => p.id === session.projectId)
  const siblings = sessions.filter((s) => s.projectId === session.projectId)

  return (
    <div className={`shell${desktop && docked ? ' split' : ''}`}>
      {desktop && docked && <SessionSidebar session={session} onClose={() => setDocked(false)} docked />}

      <div className="app">
        <header className="topbar">
          {connState === 'offline' && <div className="banner warn">Sin conexión — reintentando…</div>}
          {connState === 'unauthorized' && <div className="banner">El servidor rechazó el token.</div>}

          <div className="topbar-row">
            <button className="icon-button" onClick={back} aria-label="Atrás">
              <IconBack />
            </button>
            <button
              className={`icon-button${sidebarVisible ? ' on' : ''}`}
              onClick={toggleSidebar}
              aria-label={sidebarVisible ? 'Ocultar panel' : 'Mostrar panel'}
              aria-pressed={sidebarVisible}
            >
              <IconPanelLeft />
            </button>
            <button className="session-button" onClick={() => setSwitcher(true)}>
              <span className={`dot ${session.status}`} />
              <span className="session-button-text">
                <span className="session-title">{session.title}</span>
                <span className="session-sub">
                  {project?.name ?? shortPath(session.cwd)} · {statusLabel(session.status)}
                </span>
              </span>
              {siblings.length > 1 && <IconChevronRight size={15} />}
            </button>
            <button className="icon-button" onClick={() => setSettings(true)} aria-label="Ajustes">
              <IconSettings />
            </button>
          </div>
        </header>

        <Conversation session={session} />
        <Composer session={session} />
      </div>

      {switcher && (
        <Sheet title={project?.name ?? 'Sesiones'} onClose={() => setSwitcher(false)}>
          {siblings.map((s) => (
            <button
              key={s.id}
              className={`session-row${s.id === session.id ? ' active' : ''}`}
              onClick={() => {
                setSwitcher(false)
                if (s.id !== session.id) openSession(s.id)
              }}
            >
              <span className={`dot ${s.status}`} />
              <span className="session-row-main">
                <span className="session-row-title">{s.title}</span>
                <span className="session-row-sub">
                  {statusLabel(s.status)} · {formatCost(s.totalCostUsd)}
                </span>
              </span>
              {s.pendingPermissions.length > 0 && <span className="badge">{s.pendingPermissions.length}</span>}
            </button>
          ))}
        </Sheet>
      )}

      {!desktop && drawer && <SessionSidebar session={session} onClose={() => setDrawer(false)} />}
      {settings && <SessionSettingsSheet session={session} onClose={() => setSettings(false)} />}
    </div>
  )
}

/**
 * Deslizar desde el borde izquierdo abre el panel; deslizar a la izquierda lo
 * cierra. En un teléfono llegar al icono de la cabecera con el pulgar es
 * incómodo, y el gesto sale gratis.
 */
function useEdgeSwipe(enabled: boolean, setOpen: (open: boolean) => void) {
  const start = useRef<{ x: number; y: number; armed: boolean } | null>(null)

  useEffect(() => {
    if (!enabled) return

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      const insideDrawer = !!(e.target as HTMLElement)?.closest?.('.sidebar')
      start.current = { x: t.clientX, y: t.clientY, armed: t.clientX < 26 || insideDrawer }
    }

    const onEnd = (e: TouchEvent) => {
      const from = start.current
      start.current = null
      const t = e.changedTouches[0]
      if (!from?.armed || !t) return
      const dx = t.clientX - from.x
      // Si el dedo se fue más en vertical que en horizontal era scroll, no gesto.
      if (Math.abs(t.clientY - from.y) > Math.abs(dx)) return
      if (dx > 60 && from.x < 26) setOpen(true)
      else if (dx < -60) setOpen(false)
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchend', onEnd)
    }
  }, [enabled, setOpen])
}

function SessionSettingsSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const { updateSession, removeSession, hibernate, wake, back } = useStore()
  const [title, setTitle] = useState(session.title)
  const [confirm, setConfirm] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>) => {
    setFailure(null)
    try {
      await fn()
    } catch (err: any) {
      setFailure(err?.message ?? 'Falló la operación.')
    }
  }

  return (
    <Sheet title="Ajustes de la sesión" onClose={onClose}>
      <div className="field">
        <label htmlFor="se-title">Nombre</label>
        <input
          id="se-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== session.title && run(() => updateSession(session.id, { title }))}
        />
      </div>

      <div className="field">
        <label>Modelo</label>
        <div className="seg">
          {MODELS.map((m) => (
            <button
              key={m.id}
              className={session.model === m.id ? 'on' : ''}
              onClick={() => run(() => updateSession(session.id, { model: m.id }))}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Permisos</label>
        <div className="seg">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={session.permissionMode === m.id ? 'on' : ''}
              onClick={() => run(() => updateSession(session.id, { permissionMode: m.id }))}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="field-hint">Se aplica en caliente, sin reiniciar la sesión.</span>
      </div>

      <div className="field">
        <label>Estado</label>
        <span className="field-hint">
          {statusLabel(session.status)} · {session.numTurns} turnos · {formatCost(session.totalCostUsd)} acumulado
        </span>
        {session.status === 'dormant' ? (
          <button className="btn block" onClick={() => run(() => wake(session.id))}>
            Despertar proceso
          </button>
        ) : (
          <button className="btn block" onClick={() => run(() => hibernate(session.id))}>
            Hibernar y volcar al knowledge
          </button>
        )}
      </div>

      {failure && <div className="notice error">{failure}</div>}

      <div className="field">
        <label>Zona peligrosa</label>
        {confirm ? (
          <div className="permission-actions">
            <button
              className="btn danger"
              onClick={() =>
                run(async () => {
                  await removeSession(session.id)
                  onClose()
                  back()
                })
              }
            >
              Sí, borrar
            </button>
            <button className="btn ghost" onClick={() => setConfirm(false)}>
              Cancelar
            </button>
          </div>
        ) : (
          <button className="btn danger block" onClick={() => setConfirm(true)}>
            <span className="row-center">
              <IconTrash /> Borrar sesión e historial
            </span>
          </button>
        )}
      </div>
    </Sheet>
  )
}
