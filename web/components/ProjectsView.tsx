'use client'

import { useRef, useState } from 'react'
import { api } from '@/lib/api'
import { formatCost, relativeTime } from '@/lib/items'
import { modelLabel } from '@/lib/models'
import { useStore } from '@/lib/store'
import type { ProjectView, SessionView } from '@/lib/types'
import { AccountSheet } from './AccountSheet'
import { LocalFileViewer } from './FileViewer'
import { IconChat, IconClose, IconGrid, IconList, IconPaperclip, IconPlus, IconUser, IconUsers } from './Icons'
import { Sheet } from './Sheet'

type Mode = 'cards' | 'list'
const MODE_KEY = 'claude-remote.projects.mode'

export function ProjectsView() {
  const { projects, me, go, openSession, refresh, defaults } = useStore()
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

/** Un archivo elegido para el arranque, que todavía no se ha subido. */
type Staged = { key: string; file: File }

function NewProjectSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (result: { project: ProjectView; session: SessionView | null }) => void
}) {
  const { conn } = useStore()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [staged, setStaged] = useState<Staged[]>([])
  const [preview, setPreview] = useState<File | null>(null)
  const [step, setStep] = useState<null | 'creating' | 'uploading' | 'starting'>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  const busy = step !== null

  /**
   * Crear, subir y arrancar, en ese orden: los archivos necesitan que el
   * proyecto exista, y el agente no debe leer el encargo hasta que estén.
   */
  const submit = async () => {
    if (!name.trim()) return setFailure('Ponle un nombre.')
    if (!conn) return setFailure('Sin conexión.')
    setFailure(null)
    setStep('creating')
    try {
      const created = await api.createProject(conn, {
        name: name.trim(),
        description: description.trim(),
        deferKickoff: staged.length > 0,
      })

      if (!staged.length) return onCreated(created)

      setStep('uploading')
      const paths: string[] = []
      const failed: string[] = []
      for (const { file } of staged) {
        try {
          paths.push((await api.uploadFile(conn, created.project.id, file)).path)
        } catch {
          failed.push(file.name)
        }
      }

      // El proyecto ya existe: si una subida falló, se avisa pero se arranca
      // igual con lo que sí llegó — deshacerlo sería peor.
      setStep('starting')
      const { session } = await api.kickoff(conn, created.project.id, {
        sessionId: created.session?.id,
        attachments: paths,
      })
      if (failed.length) console.warn('[proyecto] no se subieron:', failed.join(', '))
      onCreated({ project: created.project, session })
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo crear.')
      setStep(null)
    }
  }

  const label =
    step === 'creating'
      ? 'Creando…'
      : step === 'uploading'
        ? 'Subiendo archivos…'
        : step === 'starting'
          ? 'Arrancando la sesión…'
          : 'Crear proyecto'

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

      <div className="field">
        <label>Archivos de partida</label>
        {staged.length > 0 && (
          <div className="attachments">
            {staged.map(({ key, file }) => (
              <span key={key} className="attachment ready">
                <button className="attachment-name" onClick={() => setPreview(file)} aria-label={`Ver ${file.name}`}>
                  {file.name}
                </button>
                <button
                  className="attachment-drop"
                  onClick={() => setStaged((prev) => prev.filter((s) => s.key !== key))}
                  aria-label={`Quitar ${file.name}`}
                  disabled={busy}
                >
                  <IconClose size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const chosen = Array.from(e.target.files ?? [])
            setStaged((prev) => [...prev, ...chosen.map((file) => ({ key: `s${seq.current++}`, file }))])
            e.target.value = ''
          }}
        />
        <button className="btn ghost block" onClick={() => fileRef.current?.click()} disabled={busy}>
          <span className="row-center">
            <IconPaperclip size={16} /> Adjuntar archivos
          </span>
        </button>
        <span className="field-hint">
          Un boceto, un pliego, una hoja de datos. Se suben a <code className="inline-code">subidas/</code> al
          crear el proyecto y la primera sesión arranca leyéndolos. Tócalos para verlos antes.
        </span>
      </div>

      {failure && <div className="notice error">{failure}</div>}

      <button className="btn primary block" onClick={() => void submit()} disabled={busy}>
        {label}
      </button>

      {preview && <LocalFileViewer file={preview} onClose={() => setPreview(null)} />}
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
