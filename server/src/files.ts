import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { lookup as dnsLookup } from 'node:dns/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HttpError } from './auth.js'
import { assertInsideProject } from './projects.js'
import type { FileKind, FileView, Project } from './types.js'

/** Tamaño máximo que se envía como texto al visor; el resto se recorta. */
const MAX_TEXT_BYTES = 400_000
/** Tope de descarga desde la red. */
const MAX_FETCH_BYTES = 50 * 1024 * 1024
/** Tope de subida desde el dispositivo del usuario. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/** Carpeta del proyecto donde aterriza lo que sube el usuario. */
export const UPLOAD_DIR = 'subidas'

const MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
  '.css': 'text/css',
  '.html': 'text/html',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.toml': 'text/plain',
  '.csv': 'text/csv',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.sql': 'text/plain',
  '.env': 'text/plain',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export function kindFor(path: string, mime: string): FileKind {
  const ext = extname(path).toLowerCase()
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  if (mime === 'application/pdf') return 'pdf'
  // El SVG se trata como texto: renderizarlo como imagen ejecutaría su script.
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image'
  if (mime.startsWith('text/') || mime === 'application/json') return 'text'
  return 'binary'
}

/** Metadata + contenido si es texto. El binario se pide por la ruta `raw`. */
export function readFileView(project: Project, relPath: string): FileView {
  const full = assertInsideProject(project, relPath)
  if (!existsSync(full)) throw new HttpError(404, 'El archivo no existe.')
  const stat = statSync(full)
  if (stat.isDirectory()) throw new HttpError(400, 'Eso es una carpeta.')

  const mime = mimeFor(full)
  const kind = kindFor(full, mime)
  let content: string | null = null
  let truncated = false

  if (kind === 'markdown' || kind === 'text') {
    const raw = readFileSync(full)
    truncated = raw.byteLength > MAX_TEXT_BYTES
    content = raw.subarray(0, MAX_TEXT_BYTES).toString('utf8')
  }

  return {
    path: relPath,
    name: basename(full),
    kind,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mime,
    content,
    truncated,
  }
}

export function resolveForStream(project: Project, relPath: string): { full: string; mime: string; size: number } {
  const full = assertInsideProject(project, relPath)
  if (!existsSync(full)) throw new HttpError(404, 'El archivo no existe.')
  const stat = statSync(full)
  if (stat.isDirectory()) throw new HttpError(400, 'Eso es una carpeta.')
  return { full, mime: mimeFor(full), size: stat.size }
}

// ------------------------------------------------------------- subir archivo

/**
 * Guarda en el proyecto un archivo que llega en el cuerpo de la petición.
 *
 * El cuerpo es el archivo tal cual, sin `multipart`: se sube de uno en uno, así
 * que envolverlo no aportaba nada y sí una dependencia más. Se escribe a disco
 * según llega en vez de acumularlo en memoria — el servidor corre en el Mac del
 * usuario y una foto de 40 MB no debería reservarse entera solo para copiarla.
 */
export async function saveUpload(
  project: Project,
  input: { name: string; body: Readable },
): Promise<{ path: string; size: number; mime: string }> {
  const relPath = uniquePath(project, safeUploadPath(input.name))
  const full = assertInsideProject(project, relPath)
  mkdirSync(dirname(full), { recursive: true })

  // El Content-Length puede mentir o faltar: el tope se aplica a lo que llega.
  let written = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.byteLength
      if (written > MAX_UPLOAD_BYTES) return cb(new HttpError(413, 'El archivo supera los 50 MB.'))
      cb(null, chunk)
    },
  })

  try {
    await pipeline(input.body, counter, createWriteStream(full))
  } catch (err) {
    // Una subida cortada a medias no debe dejar un archivo truncado que el
    // agente confunda con bueno.
    if (existsSync(full)) unlinkSync(full)
    throw err
  }

  if (written === 0) {
    unlinkSync(full)
    throw new HttpError(400, 'El archivo llegó vacío.')
  }

  return { path: relPath, size: written, mime: mimeFor(full) }
}

/** Destino seguro dentro de `subidas/`: sin rutas, sin dotfiles, sin control. */
function safeUploadPath(requested: string): string {
  let name = basename(requested.trim())
    .replace(/[/\\]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  if (!name) name = 'archivo'
  if (name.length > 120) {
    const ext = extname(name).slice(0, 12)
    name = name.slice(0, 120 - ext.length) + ext
  }
  return join(UPLOAD_DIR, name)
}

/**
 * Evita pisar lo ya subido. Sin esto, dos fotos del carrete con el mismo
 * `IMG_0001.jpg` se sobrescribirían la una a la otra sin avisar.
 */
function uniquePath(project: Project, relPath: string): string {
  const ext = extname(relPath)
  const stem = relPath.slice(0, relPath.length - ext.length)
  let candidate = relPath
  for (let n = 2; existsSync(assertInsideProject(project, candidate)); n++) {
    if (n > 999) throw new HttpError(409, 'Ya hay demasiados archivos con ese nombre.')
    candidate = `${stem}-${n}${ext}`
  }
  return candidate
}

// ------------------------------------------------------- traer desde la red

/**
 * Descarga un documento de internet a la carpeta del proyecto.
 *
 * El servidor corre en la máquina del usuario y detrás de su router, así que
 * una URL controlada por el modelo o por otro usuario podría alcanzar la red
 * local. Por eso se resuelve el DNS y se rechaza cualquier IP privada, tanto
 * en la URL original como en cada redirección.
 */
export async function fetchIntoProject(
  project: Project,
  input: { url: string; path?: string },
): Promise<{ path: string; size: number; mime: string }> {
  const url = parsePublicUrl(input.url)
  await assertPublicHost(url.hostname)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  let response: Response
  try {
    response = await fetch(url, { redirect: 'manual', signal: controller.signal })

    // Las redirecciones se siguen a mano para revalidar el destino: si no,
    // una URL pública podría rebotar a 127.0.0.1.
    let hops = 0
    while (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (++hops > 5) throw new HttpError(400, 'Demasiadas redirecciones.')
      const next = parsePublicUrl(new URL(response.headers.get('location')!, url).toString())
      await assertPublicHost(next.hostname)
      response = await fetch(next, { redirect: 'manual', signal: controller.signal })
    }

    if (!response.ok) throw new HttpError(400, `El servidor remoto respondió ${response.status}.`)

    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_FETCH_BYTES) {
      throw new HttpError(413, `El archivo pesa ${(declared / 1e6).toFixed(1)} MB; el tope son 50 MB.`)
    }

    const relPath = safeDestination(input.path, url, response.headers.get('content-type'))
    const full = assertInsideProject(project, relPath)
    mkdirSync(dirname(full), { recursive: true })

    if (!response.body) throw new HttpError(400, 'La respuesta venía vacía.')

    // El Content-Length puede mentir: se cuenta lo que llega de verdad.
    let written = 0
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        written += chunk.byteLength
        if (written > MAX_FETCH_BYTES) throw new HttpError(413, 'El archivo supera los 50 MB.')
        ctrl.enqueue(chunk)
      },
    })

    try {
      await pipeline(Readable.fromWeb(response.body.pipeThrough(counter) as never), createWriteStream(full))
    } catch (err) {
      if (existsSync(full)) unlinkSync(full)
      throw err
    }

    return { path: relPath, size: written, mime: mimeFor(full) }
  } finally {
    clearTimeout(timeout)
  }
}

function parsePublicUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new HttpError(400, 'La URL no es válida.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'Solo se permiten URLs http o https.')
  }
  return url
}

async function assertPublicHost(hostname: string) {
  let addresses: { address: string }[]
  try {
    addresses = await dnsLookup(hostname, { all: true })
  } catch {
    throw new HttpError(400, `No se pudo resolver ${hostname}.`)
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new HttpError(403, `${hostname} apunta a una dirección de red interna (${address}).`)
    }
  }
}

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase()
    if (v6 === '::1' || v6 === '::') return true
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true // unique local
    if (v6.startsWith('fe80')) return true // link local
    // IPv4 mapeada (::ffff:127.0.0.1)
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/)
    return mapped ? isPrivateAddress(mapped[1]) : false
  }
  const [a, b] = ip.split('.').map(Number)
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true // link local / metadata de nube
  if (a >= 224) return true // multicast y reservadas
  return false
}

/** Nombre de destino seguro: sin rutas, sin dotfiles, con extensión razonable. */
function safeDestination(requested: string | undefined, url: URL, contentType: string | null): string {
  const raw = requested?.trim() || decodeURIComponent(basename(url.pathname)) || 'descarga'
  let name = basename(raw).replace(/[/\\]/g, '').replace(/^\.+/, '')
  if (!name) name = 'descarga'
  if (!extname(name)) {
    const ext = extFromMime(contentType)
    if (ext) name += ext
  }
  return join('descargas', name)
}

function extFromMime(contentType: string | null): string | null {
  if (!contentType) return null
  const mime = contentType.split(';')[0].trim().toLowerCase()
  const found = Object.entries(MIME).find(([, value]) => value === mime)
  return found ? found[0] : null
}
