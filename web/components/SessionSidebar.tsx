'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { formatCost, formatDuration, statusLabel } from '@/lib/items'
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
} from '@/lib/timeline'
import type { KnowledgeEntry, PermissionMode, SessionView } from '@/lib/types'
import { FileViewer } from './FileViewer'
import { IconChat, IconClose, IconFile, IconPanelLeft, IconPlus } from './Icons'

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
            <FilesTab files={files} onOpen={setOpenFile} onJump={jumpTo} empty={log.length === 0} />
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

function FilesTab({
  files,
  onOpen,
  onJump,
  empty,
}: {
  files: ReturnType<typeof touchedFiles>
  onOpen: (path: string) => void
  onJump: (seq: number) => void
  empty: boolean
}) {
  if (!files.length) {
    return (
      <p className="field-hint">
        {empty ? 'Abre la conversación para ver los archivos.' : 'Esta sesión todavía no ha tocado archivos.'}
      </p>
    )
  }

  return (
    <div className="stack">
      {files.map((file) => {
        // Una ruta que sigue siendo absoluta quedó fuera del proyecto: el
        // visor no puede abrirla, así que no se ofrece como si pudiera.
        const openable = !file.path.startsWith('/')
        return (
          <div key={file.path} className={`file-row${file.failed ? ' failed' : ''}`}>
            <button className="file-main" onClick={() => openable && onOpen(file.path)} disabled={!openable}>
              <IconFile />
              <span className="file-text">
                <span className="file-name">{file.name}</span>
                <span className="file-path">{file.path}</span>
              </span>
            </button>
            <button className="file-jump" onClick={() => onJump(file.seq)}>
              <span className={`chip ${file.action}`}>
                {file.failed ? (openable ? 'falló' : 'bloqueado') : file.action}
              </span>
            </button>
          </div>
        )
      })}
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
  const { sessions, openSession, createSession, defaults } = useStore()
  const siblings = sessions.filter((s) => s.projectId === session.projectId)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [model, setModel] = useState<string>(defaults?.model ?? 'claude-opus-5')
  const [mode, setMode] = useState<PermissionMode>('default')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

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
      {siblings.map((s) => (
        <button
          key={s.id}
          className={`session-row${s.id === session.id ? ' active' : ''}`}
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
      ))}

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
