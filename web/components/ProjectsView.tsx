'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { formatCost, relativeTime } from '@/lib/items'
import { modelLabel } from '@/lib/models'
import { useStore } from '@/lib/store'
import type { ProjectView, SessionView } from '@/lib/types'
import { AccountSheet } from './AccountSheet'
import { IconChat, IconGrid, IconList, IconPlus, IconUser, IconUsers } from './Icons'
import { Sheet } from './Sheet'

type Mode = 'cards' | 'list'
const MODE_KEY = 'claude-remote.projects.mode'

export function ProjectsView() {
  const { projects, me, go, openSession, refresh, conn, defaults } = useStore()
  const [mode, setMode] = useState<Mode>(
    () => ((typeof window !== 'undefined' && localStorage.getItem(MODE_KEY)) as Mode) || 'cards',
  )
  const [creating, setCreating] = useState(false)
  const [account, setAccount] = useState(false)

  const setModePersisted = (next: Mode) => {
    setMode(next)
    localStorage.setItem(MODE_KEY, next)
  }

  const atLimit =
    me?.limits.maxProjects !== null && me !== null && me.projectCount >= (me.limits.maxProjects ?? Infinity)

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <div className="session-button-text">
            <span className="session-title">Proyectos</span>
            <span className="session-sub">
              {me?.name}
              {me?.role === 'admin' ? ' · admin' : ''} · {formatCost(me?.usage.monthUsd ?? 0)} este mes
              {me?.limits.monthlyUsd != null ? ` de ${formatCost(me.limits.monthlyUsd)}` : ''}
            </span>
          </div>

          <button
            className="icon-button"
            onClick={() => setModePersisted(mode === 'cards' ? 'list' : 'cards')}
            aria-label="Cambiar vista"
          >
            {mode === 'cards' ? <IconList /> : <IconGrid />}
          </button>

          {me?.role === 'admin' && (
            <button className="icon-button" onClick={() => go({ name: 'admin' })} aria-label="Administración">
              <IconUsers />
            </button>
          )}

          <button className="icon-button" onClick={() => setAccount(true)} aria-label="Mi cuenta">
            <IconUser />
          </button>
        </div>
      </header>

      <div className="scroll pad">
        <button className="btn primary block" onClick={() => setCreating(true)} disabled={atLimit}>
          <span className="row-center">
            <IconPlus /> Nuevo proyecto
          </span>
        </button>
        {atLimit && (
          <div className="field-hint">
            Alcanzaste tu límite de {me?.limits.maxProjects} proyectos. Habla con el administrador.
          </div>
        )}

        {projects.length === 0 ? (
          <div className="empty">
            <div className="empty-inner">
              <strong>Todavía no hay proyectos</strong>
              <span>
                Cada proyecto crea su propia carpeta dentro de{' '}
                <code className="inline-code">{defaults?.workspace ?? 'el workspace'}</code> y guarda su
                knowledge.
              </span>
            </div>
          </div>
        ) : mode === 'cards' ? (
          <div className="cards">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} onOpen={() => go({ name: 'project', projectId: project.id })} />
            ))}
          </div>
        ) : (
          <div className="stack">
            {projects.map((project) => (
              <ProjectRow key={project.id} project={project} onOpen={() => go({ name: 'project', projectId: project.id })} />
            ))}
          </div>
        )}
      </div>

      {account && <AccountSheet onClose={() => setAccount(false)} />}

      {creating && (
        <NewProjectSheet
          onClose={() => setCreating(false)}
          onCreated={async ({ project, session }) => {
            setCreating(false)
            await refresh()
            // Si el servidor arrancó la sesión inicial, se entra directo a ella.
            if (session) openSession(session.id)
            else go({ name: 'project', projectId: project.id })
          }}
          create={async (body) => {
            if (!conn) throw new Error('Sin conexión')
            return api.createProject(conn, body)
          }}
        />
      )}
    </div>
  )
}

function ProjectCard({ project, onOpen }: { project: ProjectView; onOpen: () => void }) {
  return (
    <button className="card" onClick={onOpen}>
      <div className="card-head">
        <span className="card-title">{project.name}</span>
        {project.liveSessionCount > 0 && <span className="dot busy" />}
      </div>
      <p className="card-summary">{firstLines(project.summary ?? project.description, 3) || 'Sin resumen todavía.'}</p>
      <div className="card-foot">
        <span>
          <IconChat size={13} /> {project.sessionCount}
        </span>
        <span>{project.knowledgeEntries} notas</span>
        <span>{relativeTime(project.lastActivityAt ?? project.updatedAt)}</span>
      </div>
      <div className="card-meta">
        <span className="chip">{modelLabel(project.models.main)}</span>
        <span className="chip">{project.ownerName}</span>
        {project.autoApprove && <span className="chip on">reglas</span>}
        <span className="chip">creado {new Date(project.createdAt).toLocaleDateString('es')}</span>
      </div>
    </button>
  )
}

function ProjectRow({ project, onOpen }: { project: ProjectView; onOpen: () => void }) {
  return (
    <button className="session-row" onClick={onOpen}>
      <span className={`dot ${project.liveSessionCount > 0 ? 'busy' : 'idle'}`} />
      <span className="session-row-main">
        <span className="session-row-title">{project.name}</span>
        <span className="session-row-sub">
          {project.sessionCount} sesiones · {project.knowledgeEntries} notas ·{' '}
          {relativeTime(project.lastActivityAt ?? project.updatedAt)}
        </span>
      </span>
    </button>
  )
}

function NewProjectSheet({
  onClose,
  onCreated,
  create,
}: {
  onClose: () => void
  onCreated: (result: { project: ProjectView; session: SessionView | null }) => void
  create: (body: { name: string; description?: string }) => Promise<{
    project: ProjectView
    session: SessionView | null
  }>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const submit = async () => {
    if (!name.trim()) return setFailure('Ponle un nombre.')
    setBusy(true)
    setFailure(null)
    try {
      onCreated(await create({ name: name.trim(), description: description.trim() }))
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo crear.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title="Nuevo proyecto" onClose={onClose}>
      <div className="field">
        <label htmlFor="p-name">Nombre</label>
        <input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="API de pagos" />
        <span className="field-hint">Se crea una carpeta con este nombre dentro del workspace.</span>
      </div>

      <div className="field">
        <label htmlFor="p-desc">De qué va</label>
        <textarea
          id="p-desc"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Qué quieres construir. Ej: API REST en Node para gestionar reservas de canchas."
        />
        <span className="field-hint">
          Con esto se abre una primera sesión que te propone un plan antes de tocar nada.
        </span>
      </div>

      {failure && <div className="notice error">{failure}</div>}

      <button className="btn primary block" onClick={() => void submit()} disabled={busy}>
        {busy ? 'Creando…' : 'Crear proyecto'}
      </button>
    </Sheet>
  )
}

function firstLines(text: string | null, n: number): string {
  if (!text) return ''
  return text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, n)
    .join(' · ')
}
