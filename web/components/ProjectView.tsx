'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { FILTERS, countFiles, loadFilter, pruneTree, saveFilter, type FileFilter } from '@/lib/filetypes'
import { formatBytes, formatCost, relativeTime, statusLabel } from '@/lib/items'
import { MODELS, MODES, modelLabel } from '@/lib/models'
import { useStore } from '@/lib/store'
import type { ModelRoles, PermissionMode, ProjectView as Project, SessionView, TreeNode } from '@/lib/types'
import { FileViewer } from './FileViewer'
import {
  IconBack,
  IconBook,
  IconChat,
  IconFile,
  IconFolder,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTrash,
} from './Icons'
import { KnowledgePanel } from './KnowledgePanel'
import { Sheet } from './Sheet'

type Tab = 'sessions' | 'knowledge' | 'files'

export function ProjectView({ projectId }: { projectId: string }) {
  const { projects, sessions, back, openSession, createSession, refresh } = useStore()
  const [tab, setTab] = useState<Tab>('sessions')
  const [creating, setCreating] = useState(false)
  const [settings, setSettings] = useState(false)

  const project = projects.find((p) => p.id === projectId)
  const projectSessions = useMemo(
    () => sessions.filter((s) => s.projectId === projectId),
    [sessions, projectId],
  )

  if (!project) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="topbar-row">
            <button className="icon-button" onClick={back} aria-label="Atrás">
              <IconBack />
            </button>
            <div className="session-button-text">
              <span className="session-title">Proyecto no encontrado</span>
            </div>
          </div>
        </header>
        <div className="empty">
          <div className="empty-inner">Puede que lo hayan borrado.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <button className="icon-button" onClick={back} aria-label="Atrás">
            <IconBack />
          </button>
          <div className="session-button-text">
            <span className="session-title">{project.name}</span>
            <span className="session-sub">
              {project.slug} · {projectSessions.length} sesiones · {formatCost(sumCost(projectSessions))}
            </span>
          </div>
          <button className="icon-button" onClick={() => setSettings(true)} aria-label="Ajustes">
            <IconSettings />
          </button>
        </div>

        <div className="tabs">
          <button className={tab === 'sessions' ? 'on' : ''} onClick={() => setTab('sessions')}>
            <IconChat size={15} /> Sesiones
          </button>
          <button className={tab === 'knowledge' ? 'on' : ''} onClick={() => setTab('knowledge')}>
            <IconBook size={15} /> Knowledge
          </button>
          <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
            <IconFolder size={15} /> Archivos
          </button>
        </div>
      </header>

      {tab === 'sessions' && (
        <div className="scroll pad">
          <button className="btn primary block" onClick={() => setCreating(true)}>
            <span className="row-center">
              <IconPlus /> Nueva sesión
            </span>
          </button>

          {projectSessions.length === 0 ? (
            <div className="empty">
              <div className="empty-inner">
                <strong>Sin sesiones</strong>
                <span>Puedes abrir varias a la vez sobre el mismo proyecto.</span>
              </div>
            </div>
          ) : (
            <div className="cards">
              {projectSessions.map((session) => (
                <SessionCard key={session.id} session={session} onOpen={() => openSession(session.id)} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'knowledge' && <KnowledgePanel project={project} />}
      {tab === 'files' && <FilesPanel projectId={project.id} />}

      {creating && (
        <NewSessionSheet
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            const session = await createSession(project.id, input)
            setCreating(false)
            openSession(session.id)
          }}
        />
      )}

      {settings && (
        <ProjectSettingsSheet
          project={project}
          onClose={() => setSettings(false)}
          onChanged={refresh}
          onDeleted={() => {
            setSettings(false)
            back()
            void refresh()
          }}
        />
      )}
    </div>
  )
}

function SessionCard({ session, onOpen }: { session: SessionView; onOpen: () => void }) {
  const { removeSession } = useStore()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const pending = session.pendingPermissions.length

  const remove = async () => {
    setBusy(true)
    setFailure(null)
    try {
      await removeSession(session.id)
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo borrar.')
      setBusy(false)
      setConfirm(false)
    }
  }

  return (
    <div className={`card${pending ? ' alert' : ''}`}>
      <div className="card-head">
        <span className={`dot ${session.status}`} />
        <button className="card-title" onClick={onOpen}>
          {session.title}
        </button>
        {pending > 0 && <span className="badge">{pending}</span>}
        <button
          className="icon-button danger card-del"
          onClick={() => setConfirm(true)}
          aria-label={`Borrar ${session.title}`}
        >
          <IconTrash size={15} />
        </button>
      </div>

      <button className="card-main" onClick={onOpen}>
        <p className="card-summary">{session.preview ?? 'Sin mensajes todavía.'}</p>
        <div className="card-foot">
          <span>{statusLabel(session.status)}</span>
          <span>{formatCost(session.totalCostUsd)}</span>
          <span>{relativeTime(session.lastMessageAt ?? session.updatedAt)}</span>
        </div>
        <div className="card-meta">
          <span className="chip">{modelLabel(session.model)}</span>
          <span className="chip">
            {MODES.find((m) => m.id === session.permissionMode)?.label ?? session.permissionMode}
          </span>
          <span className="chip">{session.numTurns} turnos</span>
        </div>
      </button>

      {failure && <div className="notice error">{failure}</div>}

      {confirm && (
        <div className="card-danger">
          <span className="field-hint">
            Se borra la sesión y su historial
            {session.status === 'busy' || session.status === 'starting'
              ? ', y se corta el trabajo en curso.'
              : '. No se toca ningún archivo del proyecto.'}
          </span>
          <div className="permission-actions">
            <button className="btn danger" onClick={() => void remove()} disabled={busy}>
              {busy ? 'Borrando…' : 'Sí, borrar'}
            </button>
            <button className="btn ghost" onClick={() => setConfirm(false)} disabled={busy}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ archivos

function FilesPanel({ projectId }: { projectId: string }) {
  const { conn, sessions } = useStore()
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [uploading, setUploading] = useState<string | null>(null)
  const [filter, setFilter] = useState<FileFilter>('todos')
  const fileRef = useRef<HTMLInputElement>(null)

  // El filtro se lee en un efecto: el HTML es estático y tocar localStorage al
  // renderizar rompería la hidratación.
  useEffect(() => setFilter(loadFilter()), [])

  const pruned = useMemo(() => (tree ? pruneTree(tree, filter) : null), [tree, filter])

  // Se refresca cuando alguna sesión del proyecto está trabajando: es cuando
  // aparecen archivos nuevos.
  const busy = sessions.some((s) => s.projectId === projectId && (s.status === 'busy' || s.status === 'starting'))

  const load = useCallback(async () => {
    if (!conn) return
    try {
      setTree((await api.tree(conn, projectId)).tree)
      setFailure(null)
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo leer la carpeta.')
    }
  }, [conn, projectId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void load(), 4000)
    return () => clearInterval(timer)
  }, [busy, load])

  /** Sube en serie y deja abierto el último, que es el que se acaba de elegir. */
  const upload = async (files: FileList | null) => {
    if (!files?.length || !conn) return
    setFailure(null)
    let last: string | null = null
    for (const file of Array.from(files)) {
      setUploading(file.name)
      try {
        last = (await api.uploadFile(conn, projectId, file)).path
      } catch (err: any) {
        setFailure(`${file.name}: ${err?.message ?? 'no se pudo subir.'}`)
      }
    }
    setUploading(null)
    await load()
    if (last) setOpen(last)
  }

  return (
    <div className="scroll pad">
      <div className="knowledge-actions">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void upload(e.target.files)
            e.target.value = ''
          }}
        />
        <button className="btn ghost" onClick={() => fileRef.current?.click()} disabled={!!uploading}>
          <span className="row-center">↑ {uploading ? `Subiendo ${uploading}…` : 'Subir archivo'}</span>
        </button>
        <button className="btn ghost" onClick={() => setFetching(true)}>
          <span className="row-center">↓ Traer de la red</span>
        </button>
        <button className="btn ghost" onClick={() => void load()} aria-label="Recargar">
          <IconRefresh />
        </button>
      </div>

      {failure && <div className="notice error">{failure}</div>}

      <div className="tabs file-filter">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={filter === f.id ? 'on' : ''}
            onClick={() => {
              setFilter(f.id)
              saveFilter(f.id)
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!tree ? (
        <div className="field-hint">Leyendo el árbol…</div>
      ) : !pruned ? (
        <div className="empty">
          <div className="empty-inner">
            <strong>Nada de ese tipo</strong>
            <span>El proyecto no tiene archivos en esa categoría.</span>
          </div>
        </div>
      ) : (
        <div className="tree">
          <TreeBranch node={pruned} depth={0} defaultOpen onOpenFile={setOpen} />
        </div>
      )}

      <div className="field-hint">
        {pruned && filter !== 'todos' && `${countFiles(pruned)} archivo(s) en el filtro. `}
        Se omiten <code className="inline-code">node_modules</code>, <code className="inline-code">.git</code>,{' '}
        <code className="inline-code">.venv</code> y carpetas de build. Toca un archivo para verlo o descargarlo.
      </div>

      {open && <FileViewer projectId={projectId} path={open} onClose={() => setOpen(null)} />}

      {fetching && (
        <FetchSheet
          onClose={() => setFetching(false)}
          onFetch={async (body) => {
            if (!conn) throw new Error('Sin conexión')
            const result = await api.fetchFromWeb(conn, projectId, body)
            setFetching(false)
            await load()
            setOpen(result.path)
          }}
        />
      )}
    </div>
  )
}

function FetchSheet({
  onClose,
  onFetch,
}: {
  onClose: () => void
  onFetch: (body: { url: string; path?: string }) => Promise<void>
}) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  return (
    <Sheet title="Traer documento de la red" onClose={onClose}>
      <div className="field">
        <label htmlFor="f-url">URL</label>
        <input
          id="f-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://ejemplo.com/informe.pdf"
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="url"
        />
      </div>

      <div className="field">
        <label htmlFor="f-name">Guardar como</label>
        <input
          id="f-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="opcional — por defecto el nombre de la URL"
        />
        <span className="field-hint">Se guarda en la carpeta `descargas/` del proyecto. Máximo 50 MB.</span>
      </div>

      {failure && <div className="notice error">{failure}</div>}

      <button
        className="btn primary block"
        disabled={busy || !url.trim()}
        onClick={async () => {
          setBusy(true)
          setFailure(null)
          try {
            await onFetch({ url: url.trim(), path: name.trim() || undefined })
          } catch (err: any) {
            setFailure(err?.message ?? 'No se pudo descargar.')
            setBusy(false)
          }
        }}
      >
        {busy ? 'Descargando…' : 'Descargar al proyecto'}
      </button>
    </Sheet>
  )
}

function TreeBranch({
  node,
  depth,
  defaultOpen = false,
  onOpenFile,
}: {
  node: TreeNode
  depth: number
  defaultOpen?: boolean
  onOpenFile: (path: string) => void
}) {
  const [open, setOpen] = useState(defaultOpen || depth < 1)

  if (node.type === 'file') {
    return (
      <button className="tree-row" style={{ paddingLeft: depth * 14 }} onClick={() => onOpenFile(node.path)}>
        <IconFile />
        <span className="tree-name">{node.name}</span>
        {node.mtimeMs !== undefined && <span className="tree-when">{relativeTime(node.mtimeMs)}</span>}
        {node.size !== undefined && <span className="tree-size">{formatBytes(node.size)}</span>}
      </button>
    )
  }

  return (
    <>
      <button className="tree-row" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen((v) => !v)}>
        <IconFolder />
        <span className="tree-name">{node.name}</span>
        <span className="tree-size">{open ? '−' : '+'}</span>
      </button>
      {open &&
        node.children?.map((child) => (
          <TreeBranch key={child.path} node={child} depth={depth + 1} onOpenFile={onOpenFile} />
        ))}
      {open && node.truncated && (
        <div className="tree-row" style={{ paddingLeft: (depth + 1) * 14 }}>
          <span className="tree-size">…recortado</span>
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------------ sheets

function NewSessionSheet({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (input: {
    title?: string
    model?: string
    permissionMode?: PermissionMode
    message?: string
  }) => Promise<void>
}) {
  const { defaults } = useStore()
  const [title, setTitle] = useState('')
  const [model, setModel] = useState(defaults?.model ?? 'claude-opus-5')
  const [mode, setMode] = useState<PermissionMode>('default')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const activeMode = MODES.find((m) => m.id === mode)

  const submit = async () => {
    setBusy(true)
    setFailure(null)
    try {
      await onCreate({
        title: title.trim() || undefined,
        model,
        permissionMode: mode,
        message: message.trim() || undefined,
      })
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo crear.')
      setBusy(false)
    }
  }

  return (
    <Sheet title="Nueva sesión" onClose={onClose}>
      <div className="field">
        <label htmlFor="s-title">Nombre</label>
        <input
          id="s-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="opcional — p. ej. 'refactor auth'"
        />
      </div>

      <div className="field">
        <label>Modelo</label>
        <div className="seg">
          {MODELS.map((m) => (
            <button key={m.id} className={model === m.id ? 'on' : ''} onClick={() => setModel(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Permisos</label>
        <div className="seg">
          {MODES.map((m) => (
            <button key={m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        {activeMode && <span className="field-hint">{activeMode.hint}</span>}
      </div>

      <div className="field">
        <label htmlFor="s-msg">Primer mensaje</label>
        <textarea
          id="s-msg"
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="opcional — arranca la sesión de una vez"
        />
      </div>

      {failure && <div className="notice error">{failure}</div>}

      <button className="btn primary block" onClick={() => void submit()} disabled={busy}>
        {busy ? 'Creando…' : 'Crear sesión'}
      </button>
    </Sheet>
  )
}

const ROLES: { key: keyof ModelRoles; label: string; hint: string; optional: boolean }[] = [
  { key: 'main', label: 'Trabajo', hint: 'El que ejecuta las sesiones nuevas.', optional: false },
  {
    key: 'plan',
    label: 'Planificación',
    hint: 'Se usa mientras la sesión está en modo plan; al salir vuelve al de trabajo.',
    optional: true,
  },
  {
    key: 'rules',
    label: 'Aceptación de reglas',
    hint: 'Decide los permisos según tus reglas. Conviene uno barato y rápido.',
    optional: true,
  },
  { key: 'knowledge', label: 'Knowledge', hint: 'Resume las sesiones y el proyecto.', optional: true },
]

function ProjectSettingsSheet({
  project,
  onClose,
  onChanged,
  onDeleted,
}: {
  project: Project
  onClose: () => void
  onChanged: () => Promise<void>
  onDeleted: () => void
}) {
  const { conn } = useStore()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [rules, setRules] = useState(project.rules)
  const [confirm, setConfirm] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>) => {
    setFailure(null)
    try {
      await fn()
      await onChanged()
    } catch (err: any) {
      setFailure(err?.message ?? 'Falló la operación.')
    }
  }

  const patch = (body: Parameters<typeof api.updateProject>[2]) =>
    conn && run(() => api.updateProject(conn, project.id, body))

  return (
    <Sheet title="Ajustes del proyecto" onClose={onClose}>
      <div className="field">
        <label htmlFor="pe-name">Nombre</label>
        <input
          id="pe-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() !== project.name && patch({ name: name.trim() })}
        />
      </div>

      <div className="field">
        <label htmlFor="pe-desc">De qué va</label>
        <textarea
          id="pe-desc"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== project.description && patch({ description })}
        />
      </div>

      {/* Un modelo por rol: planificar, aceptar reglas y resumir tienen
          exigencias distintas y precios muy distintos. */}
      <div className="field">
        <label>Modelos por rol</label>
        {ROLES.map((role) => (
          <div key={role.key} className="role">
            <span className="role-label">{role.label}</span>
            <div className="seg">
              {role.optional && (
                <button
                  className={project.models[role.key] === null ? 'on' : ''}
                  onClick={() => patch({ models: { [role.key]: null } })}
                >
                  {role.key === 'plan' ? 'El de trabajo' : 'Por defecto'}
                </button>
              )}
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  className={project.models[role.key] === m.id ? 'on' : ''}
                  onClick={() => patch({ models: { [role.key]: m.id } })}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="field-hint">{role.hint}</span>
          </div>
        ))}
      </div>

      <div className="field">
        <label htmlFor="pe-rules">Reglas de aceptación</label>
        <textarea
          id="pe-rules"
          rows={5}
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          onBlur={() => rules !== project.rules && patch({ rules })}
          placeholder={'Permitir leer y editar archivos dentro del proyecto.\nPermitir npm test y npm run build.\nNo permitir borrar archivos ni tocar git.'}
        />
        <span className="field-hint">
          Una regla por línea, en lenguaje natural. El modelo de reglas las aplica antes de preguntarte.
        </span>
      </div>

      <div className="field">
        <label>Auto-aprobación</label>
        <div className="seg">
          <button className={project.autoApprove ? 'on' : ''} onClick={() => patch({ autoApprove: true })}>
            Activada
          </button>
          <button className={!project.autoApprove ? 'on' : ''} onClick={() => patch({ autoApprove: false })}>
            Desactivada
          </button>
        </div>
        <span className="field-hint">
          Ante cualquier duda el modelo te pregunta igual, y hay acciones (rm -rf, git push, sudo, curl | sh)
          que nunca se auto-aprueban.
        </span>
      </div>

      <div className="field">
        <label>Knowledge automático</label>
        <div className="seg">
          <button className={project.autoKnowledge ? 'on' : ''} onClick={() => patch({ autoKnowledge: true })}>
            Activado
          </button>
          <button className={!project.autoKnowledge ? 'on' : ''} onClick={() => patch({ autoKnowledge: false })}>
            Desactivado
          </button>
        </div>
        <span className="field-hint">Resume cada sesión al cerrarla. Desactívalo para no gastar.</span>
      </div>

      <div className="field">
        <label>Carpeta</label>
        <span className="field-hint mono">{project.dir}</span>
      </div>

      {failure && <div className="notice error">{failure}</div>}

      <div className="field">
        <label>Zona peligrosa</label>
        {confirm ? (
          <div className="permission-actions">
            <button
              className="btn danger"
              onClick={() =>
                conn &&
                run(async () => {
                  await api.deleteProject(conn, project.id)
                  onDeleted()
                })
              }
            >
              Sí, quitar
            </button>
            <button className="btn ghost" onClick={() => setConfirm(false)}>
              Cancelar
            </button>
          </div>
        ) : (
          <button className="btn danger block" onClick={() => setConfirm(true)}>
            Quitar proyecto y sus sesiones
          </button>
        )}
        <span className="field-hint">Los archivos de la carpeta NO se borran: quedan en el workspace.</span>
      </div>
    </Sheet>
  )
}

function sumCost(sessions: SessionView[]): number {
  return sessions.reduce((sum, s) => sum + s.totalCostUsd, 0)
}
