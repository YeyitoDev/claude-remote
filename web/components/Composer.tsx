'use client'

import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/lib/store'
import type { SessionView } from '@/lib/types'
import { IconSend, IconStop } from './Icons'
import { SessionControls } from './SessionControls'

export function Composer({ session }: { session: SessionView }) {
  const { send, interrupt } = useStore()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)

  // Autoajuste de altura: hasta 150px y luego scroll interno.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`
  }, [text])

  const working = session.status === 'busy' || session.status === 'starting'
  const waiting = session.status === 'awaiting_permission'

  const submit = async () => {
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    setFailure(null)
    setText('')
    try {
      await send(session.id, value)
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo enviar.')
      setText(value)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="composer">
      <SessionControls session={session} />
      <div className="composer-row">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={waiting ? 'Responde el permiso arriba…' : 'Mensaje para Claude'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter envía solo con teclado físico; en móvil el Enter hace salto de línea.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        {/* Mientras trabaja se puede encolar otro mensaje, así que Enviar no desaparece:
            el botón de parar se añade al lado en vez de sustituirlo. */}
        {working && (
          <button className="send stop" onClick={() => void interrupt(session.id)} aria-label="Interrumpir">
            <IconStop />
          </button>
        )}
        <button className="send" onClick={() => void submit()} disabled={!text.trim() || busy} aria-label="Enviar">
          <IconSend />
        </button>
      </div>
      {(failure || working) && (
        <div className="composer-hint">
          <span>{failure ?? 'Claude está trabajando — puedes encolar otro mensaje.'}</span>
        </div>
      )}
    </div>
  )
}
