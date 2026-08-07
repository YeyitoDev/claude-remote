'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { Markdown } from '@/lib/markdown'
import { useStore } from '@/lib/store'
import type { FileView } from '@/lib/types'
import { IconClose, IconRefresh } from './Icons'

/** Cada cuánto se comprueba si el archivo cambió mientras está abierto. */
const POLL_MS = 2500

/**
 * Visor en vivo. Refresca solo cuando cambia el `mtime`, así que ver un
 * documento mientras Claude lo escribe muestra los cambios sin recargar nada.
 * Se sondea en vez de usar `fs.watch` porque atraviesa el túnel sin depender
 * de eventos del sistema de archivos.
 */
export function FileViewer({
  projectId,
  path,
  onClose,
}: {
  projectId: string
  path: string
  onClose: () => void
}) {
  const { conn } = useStore()
  const [file, setFile] = useState<FileView | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const mtimeRef = useRef<number>(0)
  const blobRef = useRef<string | null>(null)

  const releaseBlob = () => {
    if (blobRef.current) URL.revokeObjectURL(blobRef.current)
    blobRef.current = null
  }

  const load = useCallback(
    async (force = false) => {
      if (!conn) return
      try {
        const { file: next } = await api.file(conn, projectId, path)
        if (!force && next.mtimeMs === mtimeRef.current) return
        const changed = mtimeRef.current !== 0 && next.mtimeMs !== mtimeRef.current
        mtimeRef.current = next.mtimeMs
        setFile(next)
        setFailure(null)

        if (next.kind === 'image' || next.kind === 'pdf') {
          releaseBlob()
          const url = await api.fileBlobUrl(conn, projectId, path)
          blobRef.current = url
          setBlobUrl(url)
        }

        if (changed) {
          setLive(true)
          setTimeout(() => setLive(false), 1600)
        }
      } catch (err: any) {
        setFailure(err?.message ?? 'No se pudo abrir el archivo.')
      }
    },
    [conn, projectId, path],
  )

  useEffect(() => {
    void load(true)
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      clearInterval(timer)
      releaseBlob()
    }
  }, [load])

  const download = async () => {
    if (!conn || !file) return
    try {
      const url = await api.fileBlobUrl(conn, projectId, path)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      a.click()
      // Se revoca con retraso: revocar de inmediato cancela la descarga.
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo descargar.')
    }
  }

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="viewer" role="dialog" aria-modal="true" aria-label={file?.name ?? path}>
        <div className="viewer-head">
          <div className="viewer-title">
            <span className="viewer-name">{file?.name ?? path}</span>
            <span className="viewer-meta">
              {file ? `${formatBytes(file.size)} · ${new Date(file.mtimeMs).toLocaleTimeString('es')}` : '…'}
              {live && <span className="live-dot"> · actualizado</span>}
            </span>
          </div>
          <button className="icon-button" onClick={() => void load(true)} aria-label="Recargar">
            <IconRefresh />
          </button>
          <button className="icon-button" onClick={() => void download()} aria-label="Descargar">
            ↓
          </button>
          <button className="icon-button" onClick={onClose} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="viewer-body">
          {failure && <div className="notice error">{failure}</div>}

          {file?.kind === 'markdown' && (
            <div className="prose">
              <Markdown text={file.content ?? ''} />
            </div>
          )}

          {file?.kind === 'text' && <pre className="code viewer-code">{file.content}</pre>}

          {file?.kind === 'image' && blobUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="viewer-image" src={blobUrl} alt={file.name} />
          )}

          {file?.kind === 'pdf' && blobUrl && (
            <>
              <iframe className="viewer-pdf" src={blobUrl} title={file.name} />
              <button className="btn ghost block" onClick={() => window.open(blobUrl, '_blank')}>
                Abrir en otra pestaña
              </button>
              <span className="field-hint">
                Si el PDF sale en blanco (pasa en Safari de iOS), ábrelo en otra pestaña o descárgalo.
              </span>
            </>
          )}

          {file?.kind === 'binary' && (
            <div className="empty">
              <div className="empty-inner">
                <strong>{file.mime}</strong>
                <span>No se puede previsualizar este formato.</span>
                <button className="btn primary" onClick={() => void download()}>
                  Descargar
                </button>
              </div>
            </div>
          )}

          {file?.truncated && <div className="notice warn">Archivo recortado a 400 KB para mostrarlo.</div>}
        </div>
      </div>
    </>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ------------------------------------------------------- archivo aún local

/** Tope de texto que se lee del archivo local, igual que el del visor servido. */
const MAX_LOCAL_TEXT = 400_000

/**
 * Visor de un archivo que todavía no está en el servidor.
 *
 * Al crear un proyecto los adjuntos aún no tienen ruta —el proyecto no existe
 * hasta que se pulsa Crear—, así que se leen del propio `File` con la API del
 * navegador. Usa las mismas clases que el visor de verdad para que se vea
 * igual: lo que cambia es de dónde salen los bytes, no cómo se muestran.
 */
export function LocalFileViewer({ file, onClose }: { file: File; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const kind = localKind(file)

  useEffect(() => {
    if (kind === 'image' || kind === 'pdf') {
      const objectUrl = URL.createObjectURL(file)
      setUrl(objectUrl)
      return () => URL.revokeObjectURL(objectUrl)
    }
    if (kind === 'markdown' || kind === 'text') {
      let cancelled = false
      void file
        .slice(0, MAX_LOCAL_TEXT)
        .text()
        .then((value) => !cancelled && setText(value))
      return () => {
        cancelled = true
      }
    }
  }, [file, kind])

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="viewer" role="dialog" aria-modal="true" aria-label={file.name}>
        <div className="viewer-head">
          <div className="viewer-title">
            <span className="viewer-name">{file.name}</span>
            <span className="viewer-meta">{formatBytes(file.size)} · sin subir todavía</span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="viewer-body">
          {kind === 'markdown' && (
            <div className="prose">
              <Markdown text={text ?? ''} />
            </div>
          )}

          {kind === 'text' && <pre className="code viewer-code">{text}</pre>}

          {kind === 'image' && url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="viewer-image" src={url} alt={file.name} />
          )}

          {kind === 'pdf' && url && (
            <>
              <iframe className="viewer-pdf" src={url} title={file.name} />
              <button className="btn ghost block" onClick={() => window.open(url, '_blank')}>
                Abrir en otra pestaña
              </button>
            </>
          )}

          {kind === 'binary' && (
            <div className="empty">
              <div className="empty-inner">
                <strong>{file.type || 'formato desconocido'}</strong>
                <span>No se puede previsualizar este formato.</span>
              </div>
            </div>
          )}

          {file.size > MAX_LOCAL_TEXT && (kind === 'text' || kind === 'markdown') && (
            <div className="notice warn">Archivo recortado a 400 KB para mostrarlo.</div>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * Mismo criterio que el servidor, pero sin servidor: el `type` que da el
 * navegador viene vacío a menudo, así que manda la extensión.
 */
function localKind(file: File): FileView['kind'] {
  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ''
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  if (ext === '.pdf' || file.type === 'application/pdf') return 'pdf'
  // El SVG se lee como texto: renderizarlo como imagen ejecutaría su script.
  if (ext === '.svg') return 'text'
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('text/') || file.type === 'application/json') return 'text'
  return TEXT_EXT.has(ext) ? 'text' : 'binary'
}

const TEXT_EXT = new Set([
  '.txt',
  '.json',
  '.js',
  '.mjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.css',
  '.html',
  '.yml',
  '.yaml',
  '.toml',
  '.csv',
  '.sh',
  '.py',
  '.sql',
  '.env',
])
