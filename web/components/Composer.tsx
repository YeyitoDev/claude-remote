'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useDictation } from '@/lib/speech'
import { useStore } from '@/lib/store'
import type { SessionView } from '@/lib/types'
import { FileViewer } from './FileViewer'
import { IconClose, IconMic, IconPaperclip, IconSend, IconStop } from './Icons'
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
  const [preview, setPreview] = useState<string | null>(null)
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

  const attach = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || !conn) return
      const chosen = Array.from(files)
      if (!chosen.length) return
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
    },
    [conn, session.projectId],
  )

  /**
   * Arrastrar archivos a cualquier punto de la conversación, no solo al clip.
   *
   * Los listeners van en `window` porque el objetivo útil es toda la pantalla:
   * obligar a soltar dentro de un recuadro concreto es justo lo que hace
   * incómodo el arrastre en otras apps. El contador evita que el overlay
   * parpadee al pasar por encima de los hijos, que también emiten dragleave.
   */
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      dragDepth.current++
      setDragging(true)
    }
    const onOver = (e: DragEvent) => {
      // Sin esto el navegador abre el archivo en vez de dejarlo soltar.
      if (hasFiles(e)) e.preventDefault()
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      void attach(e.dataTransfer?.files ?? null)
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [attach])

  // Lo dictado se añade a lo que ya haya escrito, no lo sustituye.
  const dictation = useDictation((phrase) =>
    setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${phrase}` : phrase)),
  )

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
              {/* Ya subido: se puede abrir en el visor para comprobar qué se
                  mandó antes de enviarlo. Mientras sube no hay nada que ver. */}
              <button
                className="attachment-name"
                onClick={() => a.path && setPreview(a.path)}
                disabled={a.status !== 'ready'}
                aria-label={a.status === 'ready' ? `Ver ${a.name}` : a.name}
              >
                {a.name}
              </button>
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

      {preview && (
        <FileViewer projectId={session.projectId} path={preview} onClose={() => setPreview(null)} />
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

        {dictation.supported && (
          <button
            className={`attach${dictation.listening ? ' listening' : ''}`}
            onClick={dictation.toggle}
            disabled={busy}
            aria-label={dictation.listening ? 'Parar el dictado' : 'Dictar'}
            aria-pressed={dictation.listening}
          >
            <IconMic size={19} />
          </button>
        )}

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

      {(failure || dictation.error || uploading || dictation.listening || working) && (
        <div className="composer-hint">
          <span>
            {failure ??
              dictation.error ??
              (uploading
                ? 'Subiendo archivos…'
                : dictation.listening
                  ? 'Escuchando… toca el micro para parar.'
                  : 'Claude está trabajando — puedes encolar otro mensaje.')}
          </span>
        </div>
      )}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-inner">
            <IconPaperclip size={26} />
            <strong>Suelta los archivos</strong>
            <span>Se suben al proyecto y se adjuntan al mensaje.</span>
          </div>
        </div>
      )}
    </div>
  )
}
