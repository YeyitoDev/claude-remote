'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/items'
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
        // El sondeo pide solo la ficha: releer el archivo —o reconvertir un
        // .docx entero— cada 2,5 s para descubrir que no cambió sale caro.
        if (!force) {
          const { file: meta } = await api.fileMeta(conn, projectId, path)
          if (meta.mtimeMs === mtimeRef.current) return
        }

        const { file: next } = await api.file(conn, projectId, path)
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

          {file?.kind === 'docx' && file.content !== null && (
            <>
              <iframe
                className="viewer-docx"
                title={file.name}
                // `sandbox` sin `allow-scripts`: el documento lo escribe el
                // agente o lo sube un usuario, así que se pinta aislado del
                // origen de la app en vez de confiar en sanearlo.
                sandbox=""
                srcDoc={docxDocument(file.content)}
              />
              <button className="btn ghost block" onClick={() => void download()}>
                Descargar el .docx original
              </button>
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

/**
 * Envuelve el HTML del .docx en un documento completo para el iframe.
 *
 * El iframe está aislado y no puede leer el tema de la app, así que el claro y
 * el oscuro se resuelven con `prefers-color-scheme`, que sí hereda del sistema.
 * El ancho de lectura se acota: un documento a 1200px no se lee.
 */
function docxDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --ink:#1a1a1a; --paper:#fff; --soft:#666; --rule:#e2e2e2; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e8e8e8; --paper:#161616; --soft:#9a9a9a; --rule:#2e2e2e; }
  }
  body {
    margin: 0; padding: 18px 20px 40px;
    background: var(--paper); color: var(--ink);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 44em;
  }
  h1,h2,h3,h4,h5,h6 { line-height: 1.25; margin: 1.4em 0 .5em; }
  h1 { font-size: 1.5em } h2 { font-size: 1.28em } h3 { font-size: 1.12em }
  p { margin: 0 0 .85em }
  ul,ol { margin: 0 0 .85em; padding-left: 1.4em }
  li { margin: .2em 0 }
  a { color: inherit }
  img { max-width: 100%; height: auto }
  table { border-collapse: collapse; width: 100%; margin: 0 0 1em; font-size: .93em }
  th,td { border: 1px solid var(--rule); padding: 6px 8px; text-align: left; vertical-align: top }
  th { background: color-mix(in srgb, var(--ink) 7%, transparent) }
  blockquote { margin: 0 0 .85em; padding-left: 12px; border-left: 3px solid var(--rule); color: var(--soft) }
</style></head><body>${body}</body></html>`
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
