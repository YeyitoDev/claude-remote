import { randomUUID } from 'node:crypto'
import { HttpError } from './auth.js'
import { config } from './config.js'
import { linksMtime, loadLinks, saveLinks } from './store.js'
import type { AccessLink } from './types.js'

/**
 * Enlaces de acceso remoto: las direcciones por las que se llega al servidor
 * (túnel de Cloudflare, IP de la LAN, Tailscale…).
 *
 * Existen porque una invitación no puede construirse con el origen desde el
 * que navega el admin: si está en `localhost:8787`, el enlace que reparta no
 * le sirve a nadie. Y los quick tunnels cambian de URL en cada arranque, así
 * que hay que poder actualizarlos sin tocar el código.
 */
export class Links {
  private links: AccessLink[]
  private mtime: number

  constructor() {
    this.links = loadLinks()
    this.mtime = linksMtime()
  }

  private persist() {
    saveLinks(this.links)
    // La escritura va con debounce; se re-lee el mtime un poco después para no
    // confundir la propia escritura con un cambio externo.
    setTimeout(() => {
      this.mtime = linksMtime()
    }, 400).unref?.()
  }

  /**
   * Recarga si el archivo cambió por fuera. `start.sh` registra la URL del
   * túnel con `set-link` mientras el servidor ya está vivo; sin esto, la
   * siguiente edición desde el panel escribiría la copia vieja y borraría el
   * enlace recién dado de alta.
   */
  private sync() {
    const current = linksMtime()
    if (current === this.mtime) return
    this.links = loadLinks()
    this.mtime = current
  }

  list(): AccessLink[] {
    this.sync()
    return [...this.links].sort((a, b) => Number(b.primary) - Number(a.primary) || a.createdAt - b.createdAt)
  }

  create(input: { label?: string; url?: string; note?: string; primary?: boolean }): AccessLink {
    this.sync()
    const url = normalize(input.url ?? '')
    if (this.links.some((l) => l.url === url)) throw new HttpError(409, 'Ese enlace ya está registrado.')

    const link: AccessLink = {
      id: randomUUID(),
      label: input.label?.trim() || guessLabel(url),
      url,
      note: input.note?.trim() ?? '',
      // El primero que se registra manda; si no, solo si se pide.
      primary: input.primary === true || this.links.length === 0,
      createdAt: Date.now(),
    }
    if (link.primary) for (const other of this.links) other.primary = false

    this.links.push(link)
    this.persist()
    return link
  }

  update(id: string, patch: { label?: string; url?: string; note?: string; primary?: boolean }): AccessLink {
    this.sync()
    const link = this.links.find((l) => l.id === id)
    if (!link) throw new HttpError(404, 'Enlace no encontrado.')

    if (patch.url !== undefined) {
      const url = normalize(patch.url)
      if (this.links.some((l) => l.id !== id && l.url === url)) {
        throw new HttpError(409, 'Ya hay otro enlace con esa dirección.')
      }
      link.url = url
    }
    if (patch.label !== undefined) link.label = patch.label.trim() || guessLabel(link.url)
    if (patch.note !== undefined) link.note = patch.note.trim()
    if (patch.primary === true) {
      for (const other of this.links) other.primary = false
      link.primary = true
    }

    this.persist()
    return link
  }

  remove(id: string) {
    this.sync()
    const wasPrimary = this.links.find((l) => l.id === id)?.primary
    this.links = this.links.filter((l) => l.id !== id)
    // Sin principal las invitaciones se quedarían sin destino por defecto.
    if (wasPrimary && this.links.length) this.links[0].primary = true
    this.persist()
  }
}

function normalize(raw: string): string {
  let value = raw.trim()
  if (!value) throw new HttpError(400, 'La dirección es obligatoria.')
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new HttpError(400, 'Esa dirección no es válida.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'Solo se permiten direcciones http o https.')
  }
  // Se guarda solo el origen: la ruta la pone la app.
  return url.origin
}

/** Etiqueta razonable a partir del host, para no obligar a escribirla. */
function guessLabel(url: string): string {
  const host = new URL(url).hostname
  if (host.endsWith('trycloudflare.com')) return 'Túnel Cloudflare'
  if (host.endsWith('.ts.net')) return 'Tailscale'
  if (host.endsWith('ngrok.io') || host.endsWith('ngrok-free.app')) return 'ngrok'
  if (host === 'localhost' || host === '127.0.0.1') return 'Local'
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'Red local'
  return host
}

export function defaultLinkHint(): string {
  return `http://localhost:${config.port}`
}
