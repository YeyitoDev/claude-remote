'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import {
  FILTERS,
  FLOW_HINT,
  FLOW_LABEL,
  flowOf,
  loadFilter,
  matches,
  saveFilter,
  type FileFilter,
  type FileFlow,
} from '@/lib/filetypes'
import { formatBytes, formatCost, formatDuration, relativeTime, statusLabel } from '@/lib/items'
import { Markdown } from '@/lib/markdown'
import { MODELS, modeLabel, modelLabel } from '@/lib/models'
import { useStore } from '@/lib/store'
import {
  buildTimeline,
  formatDay,
  groupByDay,
  pastQuestions,
  shortTime,
  touchedFiles,
  type TimelineItem,
  type TouchedFile,
} from '@/lib/timeline'
import type { KnowledgeEntry, PermissionMode, SessionView, TreeNode } from '@/lib/types'
import { FileViewer } from './FileViewer'
import { IconChat, IconClose, IconFile, IconPanelLeft, IconPlus, IconTrash } from './Icons'

type Tab = 'timeline' | 'files' | 'questions' | 'sessions'

const TABS: { id: Tab; label: string }[] = [
  { id: 'timeline', label: 'Línea' },
  { id: 'files', label: 'Archivos' },
  { id: 'questions', label: 'Preguntas' },
  { id: 'sessions', label: 'Sesiones' },
]

/**
 * Panel lateral de la sesión. Todo lo que muestra sale del log de eventos que
 * el cliente ya tiene, salvo el knowledge, que se pide una vez: una
 * conversación larga se vuelve inmanejable sin una forma de recorrerla.
 */
export function SessionSidebar({
  session,
  onClose,
  docked = false,
}: {
  session: SessionView
  onClose: () => void
  /** Fijo junto a la conversación (escritorio) en vez de superpuesto (móvil). */
  docked?: boolean
}) {
  const { events, conn } = useStore()
  const [tab, setTab] = useState<Tab>('timeline')
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([])
  const [openFile, setOpenFile] = useState<string | null>(null)

  const log = events[session.id] ?? []
  const files = useMemo(() => touchedFiles(log, session.cwd), [log, session.cwd])
  const questions = useMemo(() => pastQuestions(log), [log])
  const timeline = useMemo(() => buildTimeline(log, knowledge, session.id), [log, knowledge, session.id])

  useEffect(() => {
    if (!conn) return
    let cancelled = false
    api
      .knowledge(conn, session.projectId)
      .then((res) => !cancelled && setKnowledge(res.knowledge.days.flatMap((d) => d.entries)))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [conn, session.projectId, session.knowledgeSeq])

  useEffect(() => {
    // Fijo no es modal: ni bloquea el scroll de la página ni se cierra con Escape.
    if (docked) return
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose, docked])

  /** Salta al mensaje en la conversación. Fijo, el panel se queda abierto. */
  const jumpTo = useCallback(
    (seq: number) => {
      if (!docked) onClose()
      requestAnimationFrame(() => {
        const target = document.querySelector(`[data-seq="${seq}"]`)
        if (!target) return
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        target.classList.add('flash')
        setTimeout(() => target.classList.remove('flash'), 1400)
      })
    },
    [onClose, docked],
  )

  return (
    <>
      {!docked && <div className="sheet-backdrop" onClick={onClose} />}
      <aside
        className={`sidebar${docked ? ' docked' : ''}`}
        role={docked ? 'complementary' : 'dialog'}
        aria-modal={docked ? undefined : true}
        aria-label="Panel de la sesión"
      >
        <div className="sidebar-head">
          <div className="session-button-text">
            <span className="session-title">{session.title}</span>
            <span className="session-sub">
              {modelLabel(session.model)} · {modeLabel(session.permissionMode)} · {formatCost(session.totalCostUsd)}
            </span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={docked ? 'Ocultar panel' : 'Cerrar'}>
            {docked ? <IconPanelLeft /> : <IconClose />}
          </button>
        </div>

        <div className="tabs sidebar-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="sidebar-body">
          {tab === 'timeline' && <TimelinePanel items={timeline} onJump={jumpTo} />}
          {tab === 'files' && (
            <FilesTab session={session} files={files} onOpen={setOpenFile} onJump={jumpTo} />
          )}
          {tab === 'questions' && <QuestionsTab questions={questions} onJump={jumpTo} />}
          {tab === 'sessions' && <SessionsTab session={session} onClose={onClose} docked={docked} />}
        </div>
      </aside>

      {openFile && (
        <FileViewer projectId={session.projectId} path={openFile} onClose={() => setOpenFile(null)} />
      )}
    </>
  )
}

// ------------------------------------------------------------ línea de tiempo

function TimelinePanel({ items, onJump }: { items: TimelineItem[]; onJump: (seq: number) => void }) {
  if (!items.length) {
    return <p className="field-hint">La línea se construye sola con los turnos y el knowledge de esta sesión.</p>
  }

  return (
    <div className="timeline">
      {groupByDay(items).map((day) => (
        <div key={day.date}>
          <div className="day-head">{formatDay(day.date)}</div>
          {day.items.map((item, i) => (
            <TimelineRow key={`${item.type}-${item.ts}-${i}`} item={item} onJump={onJump} />
          ))}
        </div>
      ))}
    </div>
  )
}

function TimelineRow({ item, onJump }: { item: TimelineItem; onJump: (seq: number) => void }) {
  const [open, setOpen] = useState(false)

  if (item.type === 'knowledge') {
    return (
      <div className="tl-row knowledge">
        <span className="tl-time">{shortTime(item.ts)}</span>
        <div className="tl-body">
          <button className="tl-title" onClick={() => setOpen((v) => !v)}>
            Knowledge · {item.entry.sessionTitle}
          </button>
          {open && (
            <div className="prose small">
              <Markdown text={item.entry.content} />
            </div>
          )}
        </div>
      </div>
    )
  }

  if (item.type === 'turn') {
    return (
      <div className="tl-row">
        <span className="tl-time">{shortTime(item.ts)}</span>
        <div className="tl-body">
          <button className="tl-title" onClick={() => onJump(item.seq)}>
            {item.question.split('\n')[0].slice(0, 90)}
          </button>
          <span className="tl-meta">
            {formatDuration(item.durationMs)} · {formatCost(item.costUsd)}
          </span>
        </div>
      </div>
    )
  }

  if (item.type === 'compacted') {
    return (
      <div className="tl-row muted">
        <span className="tl-time">{shortTime(item.ts)}</span>
        <div className="tl-body">
          <span className="tl-title-static">
            Contexto compactado ({item.preTokens.toLocaleString('es')} tokens)
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="tl-row denied">
      <span className="tl-time">{shortTime(item.ts)}</span>
      <div className="tl-body">
        <span className="tl-title-static">{item.text}</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- archivos

type FileRow = {
  path: string
  name: string
  action: TouchedFile['action'] | 'en el proyecto'
  /** Null cuando el archivo no salió de esta conversación: no hay a dónde saltar. */
  seq: number | null
  times: number
  failed: boolean
  size?: number
  mtimeMs?: number
}

function flattenTree(node: TreeNode, out: TreeNode[] = []): TreeNode[] {
  if (node.type === 'file') out.push(node)
  for (const child of node.children ?? []) flattenTree(child, out)
  return out
}

/**
 * Archivos de la sesión y del proyecto, en una sola lista.
 *
 * Con solo el log de eventos se perdía justo lo que más importa: un documento
 * generado por un script sale de un `Bash`, no de un `Write`, así que no
 * aparecía por ningún lado. Se cruza con el árbol del proyecto para que lo
 * producido cuente aunque no pasara por una herramienta de archivos.
 */
function FilesTab({
  session,
  files,
  onOpen,
  onJump,
}: {
  session: SessionView
  files: TouchedFile[]
  onOpen: (path: string) => void
  onJump: (seq: number) => void
}) {
  const { conn, sessions } = useStore()
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [filter, setFilter] = useState<FileFilter>('todos')

  useEffect(() => setFilter(loadFilter()), [])

  const working = sessions.some(
    (s) => s.projectId === session.projectId && (s.status === 'busy' || s.status === 'starting'),
  )

  useEffect(() => {
    if (!conn) return
    let cancelled = false
    const load = () =>
      api
        .tree(conn, session.projectId)
        .then((res) => !cancelled && setTree(res.tree))
        .catch(() => undefined)

    void load()
    // Mientras el agente trabaja aparecen archivos nuevos; parado no hace falta.
    const timer = working ? setInterval(load, 4000) : null
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [conn, session.projectId, working])

  // El flujo se calcula al final, cuando ya se cruzaron log y árbol: antes no
  // se sabe el `mtime`, que es lo que delata un archivo generado por un script.
  const rows = useMemo<(FileRow & { flow: FileFlow })[]>(() => {
    const byPath = new Map<string, FileRow>()
    for (const file of files) {
      byPath.set(file.path, {
        path: file.path,
        name: file.name,
        action: file.action,
        seq: file.seq,
        times: file.times,
        failed: file.failed,
      })
    }

    for (const node of tree ? flattenTree(tree) : []) {
      const existing = byPath.get(node.path)
      // El árbol sabe el tamaño y la fecha; el log sabe quién lo tocó y cuándo.
      byPath.set(
        node.path,
        existing
          ? { ...existing, size: node.size, mtimeMs: node.mtimeMs }
          : {
              path: node.path,
              name: node.name,
              action: 'en el proyecto',
              seq: null,
              times: 0,
              failed: false,
              size: node.size,
              mtimeMs: node.mtimeMs,
            },
      )
    }

    return [...byPath.values()]
      .filter((row) => matches(row.name, filter))
      .map((row) => ({ ...row, flow: flowOf(row.action, row.mtimeMs, session.createdAt, row.path) }))
      .sort((a, b) => {
        // Lo que tocó esta sesión va primero: es de lo que se está hablando.
        if ((a.seq === null) !== (b.seq === null)) return a.seq === null ? 1 : -1
        if (a.seq !== null && b.seq !== null) return b.seq - a.seq
        return (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)
      })
  }, [files, tree, filter, session.createdAt])

  const groups = useMemo(
    () =>
      (['salida', 'entrada', 'consulta', 'proyecto'] as FileFlow[])
        .map((flow) => ({ flow, rows: rows.filter((r) => r.flow === flow) }))
        .filter((g) => g.rows.length > 0),
    [rows],
  )

  return (
    <div className="stack">
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

      {rows.length > 0 && (
        <div className="io-summary">
          {(['salida', 'entrada', 'consulta'] as FileFlow[]).map((flow) => {
            const n = rows.filter((r) => r.flow === flow).length
            return (
              <span key={flow} className={`io-count ${flow}${n ? '' : ' zero'}`}>
                <strong>{n}</strong> {FLOW_LABEL[flow].toLowerCase()}
              </span>
            )
          })}
        </div>
      )}

      {!rows.length ? (
        <p className="field-hint">
          {filter === 'todos'
            ? 'Todavía no hay archivos en el proyecto.'
            : 'No hay archivos de ese tipo. Prueba con «Todos».'}
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.flow} className="file-group">
            <div className="file-group-head">
              <span className={`flow-tag ${group.flow}`}>
                {group.flow === 'salida' ? '↑' : group.flow === 'entrada' ? '↓' : '·'}
              </span>
              <strong>{FLOW_LABEL[group.flow]}</strong>
              <span className="file-group-hint">{FLOW_HINT[group.flow]}</span>
            </div>

            {group.rows.map((file) => {
              // Una ruta que sigue siendo absoluta quedó fuera del proyecto: el
              // visor no puede abrirla, así que no se ofrece como si pudiera.
              const openable = !file.path.startsWith('/')
              const meta = [
                file.size !== undefined ? formatBytes(file.size) : null,
                file.mtimeMs !== undefined ? relativeTime(file.mtimeMs) : null,
                file.times > 1 ? `${file.times} veces` : null,
              ].filter(Boolean)

              // "en el proyecto" solo describe bien al que nadie tocó. Si el
              // cruce lo situó como salida o entrada, la etiqueta debe decirlo.
              const label =
                file.action !== 'en el proyecto'
                  ? file.action
                  : file.flow === 'salida'
                    ? 'generado'
                    : file.flow === 'entrada'
                      ? 'subido'
                      : file.action

              return (
                <div key={file.path} className={`file-row${file.failed ? ' failed' : ''}`}>
                  <button
                    className="file-main"
                    onClick={() => openable && onOpen(file.path)}
                    disabled={!openable}
                  >
                    <IconFile />
                    <span className="file-text">
                      <span className="file-name">{file.name}</span>
                      <span className="file-path">{file.path}</span>
                      {meta.length > 0 && <span className="file-meta">{meta.join(' · ')}</span>}
                    </span>
                  </button>
                  <button
                    className="file-jump"
                    onClick={() => file.seq !== null && onJump(file.seq)}
                    disabled={file.seq === null}
                    aria-label={file.seq !== null ? `Ir a ${file.name} en la conversación` : file.name}
                  >
                    <span className={`chip ${label === 'en el proyecto' ? 'proyecto' : label}`}>
                      {file.failed ? (openable ? 'falló' : 'bloqueado') : label}
                    </span>
                  </button>
                </div>
              )
            })}
          </div>
        ))
      )}
    </div>
  )
}

// ------------------------------------------------------------------ preguntas

function QuestionsTab({
  questions,
  onJump,
}: {
  questions: ReturnType<typeof pastQuestions>
  onJump: (seq: number) => void
}) {
  if (!questions.length) return <p className="field-hint">Todavía no has escrito nada en esta sesión.</p>
  return (
    <div className="stack">
      {questions.map((q) => (
        <button key={q.seq} className="question" onClick={() => onJump(q.seq)}>
          <span className="question-time">{shortTime(q.ts)}</span>
          <span className="question-text">{q.text}</span>
        </button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------- sesiones

/** Abrir otra sesión del mismo proyecto sin salir de la conversación actual. */
function SessionsTab({
  session,
  onClose,
  docked,
}: {
  session: SessionView
  onClose: () => void
  docked: boolean
}) {
  const { sessions, openSession, createSession, removeSession, back, defaults } = useStore()
  const siblings = sessions.filter((s) => s.projectId === session.projectId)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [model, setModel] = useState<string>(defaults?.model ?? 'claude-opus-5')
  const [mode, setMode] = useState<PermissionMode>('default')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeFailure, setRemoveFailure] = useState<string | null>(null)

  /**
   * Borrar la sesión abierta deja el panel sin nada que mostrar: se cierra y se
   * vuelve al proyecto. Borrar una hermana solo la quita de la lista.
   */
  const remove = async (id: string) => {
    setRemoving(true)
    setRemoveFailure(null)
    try {
      const wasCurrent = id === session.id
      await removeSession(id)
      setConfirmId(null)
      if (wasCurrent) {
        onClose()
        back()
      }
    } catch (err: any) {
      setRemoveFailure(err?.message ?? 'No se pudo borrar.')
      setConfirmId(null)
    } finally {
      setRemoving(false)
    }
  }

  const create = async () => {
    setBusy(true)
    setFailure(null)
    try {
      const created = await createSession(session.projectId, {
        title: title.trim() || undefined,
        model,
        permissionMode: mode,
      })
      if (!docked) onClose()
      openSession(created.id)
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo crear.')
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      {siblings.map((s) =>
        confirmId === s.id ? (
          <div key={s.id} className="session-row danger">
            <span className="session-row-main">
              <span className="session-row-title">¿Borrar «{s.title}»?</span>
              <span className="session-row-sub">
                {s.id === session.id ? 'Es la sesión abierta. ' : ''}
                Se borra su historial.
              </span>
            </span>
            <button className="btn danger tight" onClick={() => void remove(s.id)} disabled={removing}>
              {removing ? '…' : 'Borrar'}
            </button>
            <button className="btn ghost tight" onClick={() => setConfirmId(null)} disabled={removing}>
              No
            </button>
          </div>
        ) : (
          <div key={s.id} className={`session-row${s.id === session.id ? ' active' : ''}`}>
            <button
              className="session-row-open"
              onClick={() => {
                if (s.id === session.id) return docked ? undefined : onClose()
                if (!docked) onClose()
                openSession(s.id)
              }}
            >
              <span className={`dot ${s.status}`} />
              <span className="session-row-main">
                <span className="session-row-title">{s.title}</span>
                <span className="session-row-sub">
                  {statusLabel(s.status)} · {modelLabel(s.model)} · {formatCost(s.totalCostUsd)}
                </span>
              </span>
              {s.pendingPermissions.length > 0 && <span className="badge">{s.pendingPermissions.length}</span>}
            </button>
            <button
              className="icon-button danger"
              onClick={() => setConfirmId(s.id)}
              aria-label={`Borrar ${s.title}`}
            >
              <IconTrash size={15} />
            </button>
          </div>
        ),
      )}

      {removeFailure && <div className="notice error">{removeFailure}</div>}

      {creating ? (
        <div className="panel">
          <div className="field">
            <label htmlFor="par-title">Nombre</label>
            <input
              id="par-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="opcional — p. ej. 'tests'"
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
              {(['default', 'acceptEdits', 'plan'] as PermissionMode[]).map((m) => (
                <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                  {modeLabel(m)}
                </button>
              ))}
            </div>
          </div>
          {failure && <div className="notice error">{failure}</div>}
          <button className="btn primary block" onClick={() => void create()} disabled={busy}>
            {busy ? 'Creando…' : 'Crear y abrir'}
          </button>
        </div>
      ) : (
        <button className="btn primary block" onClick={() => setCreating(true)}>
          <span className="row-center">
            <IconPlus /> Sesión en paralelo
          </span>
        </button>
      )}

      <span className="field-hint">
        <IconChat size={12} /> Todas comparten la carpeta del proyecto y su knowledge, pero cada una lleva su
        propia conversación.
      </span>
    </div>
  )
}
