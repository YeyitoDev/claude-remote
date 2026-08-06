'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Markdown } from '@/lib/markdown'
import { useStore } from '@/lib/store'
import type { KnowledgeView, ProjectView } from '@/lib/types'
import { IconPlus, IconRefresh } from './Icons'
import { Sheet } from './Sheet'

/**
 * Knowledge del proyecto: arriba el resumen vivo, abajo el historial agrupado
 * por fecha. Es la vista que hace que una sesión nueva no empiece de cero.
 */
export function KnowledgePanel({ project }: { project: ProjectView }) {
  const { conn } = useStore()
  const [knowledge, setKnowledge] = useState<KnowledgeView | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!conn) return
    try {
      setKnowledge((await api.knowledge(conn, project.id)).knowledge)
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo leer el knowledge.')
    }
  }, [conn, project.id])

  useEffect(() => {
    void load()
  }, [load, project.knowledgeEntries, project.summaryUpdatedAt])

  const regenerate = async () => {
    if (!conn) return
    setBusy(true)
    setFailure(null)
    try {
      setKnowledge((await api.refreshKnowledge(conn, project.id)).knowledge)
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo regenerar.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scroll pad">
      <div className="knowledge-actions">
        <button className="btn ghost" onClick={() => void regenerate()} disabled={busy || !knowledge?.totalEntries}>
          <span className="row-center">
            <IconRefresh /> {busy ? 'Resumiendo…' : 'Regenerar resumen'}
          </span>
        </button>
        <button className="btn ghost" onClick={() => setAdding(true)}>
          <span className="row-center">
            <IconPlus size={15} /> Nota
          </span>
        </button>
      </div>

      {failure && <div className="notice error">{failure}</div>}

      <section className="panel">
        <div className="panel-head">
          <h3>Resumen</h3>
          {knowledge?.summaryUpdatedAt && (
            <span className="field-hint">{new Date(knowledge.summaryUpdatedAt).toLocaleDateString('es')}</span>
          )}
        </div>
        {knowledge?.summary ? (
          <div className="prose">
            <Markdown text={knowledge.summary} />
          </div>
        ) : (
          <p className="field-hint">
            Todavía no hay resumen. Se genera solo al cerrar sesiones, o pulsa «Regenerar resumen».
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Historial</h3>
          <span className="field-hint">{knowledge?.totalEntries ?? 0} entradas</span>
        </div>

        {!knowledge?.days.length && <p className="field-hint">Sin entradas todavía.</p>}

        {knowledge?.days.map((day) => (
          <div key={day.date} className="day">
            <div className="day-head">{formatDate(day.date)}</div>
            <div className="cards">
              {day.entries.map((entry) => (
                <article key={`${entry.ts}-${entry.sessionId}`} className="card entry-card">
                  <header className="entry-head">
                    <span className="entry-time">{entry.time}</span>
                    <span className="entry-title">{entry.sessionTitle}</span>
                  </header>
                  <div className="prose small">
                    <Markdown text={entry.content} />
                  </div>
                  <div className="card-meta">
                    <span className="chip">{entry.userName}</span>
                    <span className="chip">{entry.manual ? 'nota manual' : 'auto'}</span>
                    <span className="chip">{entry.date}</span>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}
      </section>

      {adding && (
        <NoteSheet
          onClose={() => setAdding(false)}
          onSave={async (content) => {
            if (!conn) return
            setKnowledge((await api.addNote(conn, project.id, content)).knowledge)
            setAdding(false)
          }}
        />
      )}
    </div>
  )
}

function NoteSheet({ onClose, onSave }: { onClose: () => void; onSave: (content: string) => Promise<void> }) {
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  return (
    <Sheet title="Nota al knowledge" onClose={onClose}>
      <div className="field">
        <label htmlFor="note">Contenido</label>
        <textarea
          id="note"
          rows={6}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Decisión tomada fuera de la app, contexto de negocio, algo que Claude debe saber…"
        />
        <span className="field-hint">Se guarda con la fecha de hoy y entra en el próximo resumen.</span>
      </div>

      {failure && <div className="notice error">{failure}</div>}

      <button
        className="btn primary block"
        disabled={busy || !content.trim()}
        onClick={async () => {
          setBusy(true)
          setFailure(null)
          try {
            await onSave(content.trim())
          } catch (err: any) {
            setFailure(err?.message ?? 'No se pudo guardar.')
            setBusy(false)
          }
        }}
      >
        {busy ? 'Guardando…' : 'Guardar nota'}
      </button>
    </Sheet>
  )
}

function formatDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const parsed = new Date(y, m - 1, d)
  const today = new Date()
  const isToday = parsed.toDateString() === today.toDateString()
  const label = parsed.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' })
  return isToday ? `Hoy · ${label}` : label
}
