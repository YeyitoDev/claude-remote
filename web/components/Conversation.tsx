'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { buildItems, formatCost, formatDuration, summarizeTool } from '@/lib/items'
import { Markdown } from '@/lib/markdown'
import { useStore } from '@/lib/store'
import type { Item, SessionView } from '@/lib/types'
import { IconChevronRight } from './Icons'

export function Conversation({ session }: { session: SessionView }) {
  const { events, streaming } = useStore()
  const raw = events[session.id]
  const buffer = streaming[session.id] ?? ''
  const items = useMemo(() => buildItems(raw ?? []), [raw])

  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // Autoscroll solo si el usuario ya estaba abajo: leer historial no debe
  // arrastrarte al final cada vez que llega un token.
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [items.length, buffer, session.id])

  useEffect(() => {
    pinnedRef.current = true
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session.id])

  const empty = items.length === 0 && !buffer

  return (
    <div className="stream" ref={scrollRef} onScroll={onScroll}>
      {empty ? (
        <div className="empty">
          <div className="empty-inner">
            <strong>{session.title}</strong>
            <span>
              {session.cwd}
              <br />
              Escribe abajo para arrancar la sesión.
            </span>
          </div>
        </div>
      ) : (
        items.map((item) => <ItemView key={item.key} item={item} sessionId={session.id} />)
      )}

      {buffer && (
        <div className="bubble assistant streaming">
          <Markdown text={buffer} />
          <span className="caret" />
        </div>
      )}
    </div>
  )
}

function ItemView({ item, sessionId }: { item: Item; sessionId: string }) {
  // `data-seq` es el ancla que usa el panel lateral para saltar a un punto.
  switch (item.type) {
    case 'user':
      return (
        <div className="bubble user" data-seq={item.key}>
          <Markdown text={item.text} />
        </div>
      )

    case 'assistant':
      return (
        <div className="bubble assistant" data-seq={item.key}>
          <Markdown text={item.text} />
        </div>
      )

    case 'thinking':
      return (
        <div className="thinking" aria-label="Pensando">
          <i />
          <i />
          <i />
        </div>
      )

    case 'tool':
      return <ToolCard item={item} />

    case 'permission':
      return <PermissionCard item={item} sessionId={sessionId} />

    case 'result':
      return (
        <div className="meta-chip">
          {item.isError ? 'terminó con error · ' : ''}
          {formatDuration(item.durationMs)} · {formatCost(item.costUsd)}
        </div>
      )

    case 'compacted':
      return <div className="divider">contexto compactado ({item.preTokens.toLocaleString('es')} tokens)</div>

    case 'notice':
      return <div className={`notice${item.tone === 'error' ? ' error' : ''}`}>{item.text}</div>

    default:
      return null
  }
}

function ToolCard({ item }: { item: Extract<Item, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const summary = summarizeTool(item.name, item.input)
  const inputJson = JSON.stringify(item.input, null, 2)

  return (
    <div className={`tool${item.isError ? ' error' : ''}`} data-seq={item.key}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-name">{item.name}</span>
        <span className="tool-summary">{summary || (item.result === null ? 'ejecutando…' : '')}</span>
        <span className="tool-chevron" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
          <IconChevronRight size={14} />
        </span>
      </button>

      {open && (
        <>
          <div className="tool-body">
            <span className="tool-body-label">Entrada</span>
            {inputJson}
          </div>
          {item.result !== null && (
            <div className="tool-body">
              <span className="tool-body-label">{item.isError ? 'Error' : 'Resultado'}</span>
              {truncate(item.result, 4000)}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function PermissionCard({
  item,
  sessionId,
}: {
  item: Extract<Item, { type: 'permission' }>
  sessionId: string
}) {
  const { respond } = useStore()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const decide = async (decision: 'allow' | 'allow_always' | 'deny') => {
    setBusy(true)
    setFailure(null)
    try {
      await respond(sessionId, item.request.id, decision)
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo responder.')
    } finally {
      setBusy(false)
    }
  }

  const decided = item.decision !== null

  return (
    <div className={`permission${decided ? ' resolved' : ''}`}>
      <div className="permission-title">{item.request.title}</div>
      {item.request.description && <div className="permission-desc">{item.request.description}</div>}
      <div className="permission-input">
        {summarizeTool(item.request.toolName, item.request.input) ||
          JSON.stringify(item.request.input, null, 2)}
      </div>

      {decided ? (
        <div className="field-hint">
          {item.decision === 'deny'
            ? 'Rechazado'
            : item.decision === 'allow_always'
              ? 'Permitido siempre en esta sesión'
              : 'Permitido'}
        </div>
      ) : (
        <>
          <div className="permission-actions">
            <button className="btn primary" onClick={() => decide('allow')} disabled={busy}>
              Permitir
            </button>
            <button className="btn danger" onClick={() => decide('deny')} disabled={busy}>
              Rechazar
            </button>
            {item.request.suggestionCount > 0 && (
              <button className="btn ghost wide" onClick={() => decide('allow_always')} disabled={busy}>
                Permitir siempre {item.request.toolName}
              </button>
            )}
          </div>
          {failure && <div className="field-hint">{failure}</div>}
        </>
      )}
    </div>
  )
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} caracteres más)`
}
