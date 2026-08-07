'use client'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useStore } from '@/lib/store'
import type { SessionView } from '@/lib/types'
import { IconClose, IconPaperclip, IconSend, IconStop } from './Icons'
import { SessionControls } from './SessionControls'

/**
 * Un archivo adjunto al mensaje que se está escribiendo. Sube en cuanto se
 * elige, no al enviar: así el error de una foto de 60 MB aparece mientras
 * todavía estás escribiendo y no cuando ya diste a enviar.
 */
type Attachment = {
  key: string
  name: string
  status: 'uploading' | 'ready' | 'failed'
  path?: string
  error?: string
}

export function Composer({ session }: { session: SessionView }) {
  const { send, interrupt, conn } = useStore()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  // Autoajuste de altura: hasta 150px y luego scroll interno.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`
  }, [text])

  const working = session.status === 'busy' || session.status === 'starting'
  const waiting = session.status === 'awaiting_permission'
  const uploading = attachments.some((a) => a.status === 'uploading')
  const ready = attachments.filter((a) => a.status === 'ready')

  const attach = async (files: FileList | null) => {
    if (!files?.length || !conn) return
    const chosen = Array.from(files)
    const keyed = chosen.map((file) => ({ file, key: `a${seq.current++}` }))

    setAttachments((prev) => [
      ...prev,
      ...keyed.map(({ file, key }) => ({ key, name: file.name, status: 'uploading' as const })),
    ])

    // En serie: son subidas grandes desde el móvil y en paralelo se pisan el
    // ancho de banda entre ellas sin terminar antes.
    for (const { file, key } of keyed) {
      try {
        const { path } = await api.uploadFile(conn, session.projectId, file)
        setAttachments((prev) =>
          prev.map((a) => (a.key === key ? { ...a, status: 'ready' as const, path } : a)),
        )
      } catch (err: any) {
        setAttachments((prev) =>
          prev.map((a) =>
            a.key === key
              ? { ...a, status: 'failed' as const, error: err?.message ?? 'No se pudo subir.' }
              : a,
          ),
        )
      }
    }
  }

  const submit = async () => {
    const value = text.trim()
    if ((!value && !ready.length) || busy || uploading) return

    // El agente no ve el adjunto: ve la ruta. Se le nombran los archivos
    // explícitamente para que sepa que están ahí y pueda abrirlos.
    const header = ready.length
      ? `${ready.length === 1 ? 'Archivo que acabo de subir' : 'Archivos que acabo de subir'} al proyecto:\n` +
        ready.map((a) => `- ${a.path}`).join('\n')
      : ''
    const message = [header, value].filter(Boolean).join('\n\n')

    const previous = attachments
    setBusy(true)
    setFailure(null)
    setText('')
    setAttachments([])
    try {
      await send(session.id, message)
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo enviar.')
      setText(value)
      setAttachments(previous)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="composer">
      <SessionControls session={session} />

      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <span key={a.key} className={`attachment ${a.status}`} title={a.error ?? a.path ?? a.name}>
              <span className="attachment-name">{a.name}</span>
              <span className="attachment-state">
                {a.status === 'uploading' ? 'subiendo…' : a.status === 'failed' ? 'falló' : 'listo'}
              </span>
              <button
                className="attachment-drop"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.key !== a.key))}
                aria-label={`Quitar ${a.name}`}
              >
                <IconClose size={13} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer-row">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void attach(e.target.files)
            // Sin esto, volver a elegir el mismo archivo no dispara el change.
            e.target.value = ''
          }}
        />
        <button
          className="attach"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          aria-label="Adjuntar archivo"
        >
          <IconPaperclip size={19} />
        </button>

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
        <button
          className="send"
          onClick={() => void submit()}
          disabled={(!text.trim() && !ready.length) || busy || uploading}
          aria-label="Enviar"
        >
          <IconSend />
        </button>
      </div>

      {(failure || uploading || working) && (
        <div className="composer-hint">
          <span>
            {failure ??
              (uploading
                ? 'Subiendo archivos…'
                : 'Claude está trabajando — puedes encolar otro mensaje.')}
          </span>
        </div>
      )}
    </div>
  )
}
