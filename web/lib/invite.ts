import { normalizeUrl, type Connection } from './api'

/**
 * Enlaces de invitación.
 *
 * El token va en el fragmento (`#`), no en la query: el fragmento no se envía
 * al servidor, así que no aparece en los logs de acceso ni en los del túnel.
 * Al abrirlo se guarda la conexión y se limpia la URL de inmediato para que no
 * quede en el historial ni en la barra de direcciones.
 */

/**
 * `base` es el enlace de acceso remoto elegido. Sin él se cae al origen desde
 * el que navega el admin, que puede ser `localhost` y no servirle a nadie —
 * por eso la app avisa cuando no hay ningún enlace registrado.
 */
export function buildInviteLink(conn: Connection, token: string, base?: string): string {
  const params = new URLSearchParams({ t: token })

  if (base) {
    // Un enlace de acceso ES la dirección del servidor: la app que se sirva
    // desde ahí habla con ese mismo origen. Añadir `s` la apuntaría a otro
    // sitio — por ejemplo el enlace de LAN mandando la API al túnel.
    return `${normalizeUrl(base)}/#${params.toString()}`
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : conn.url
  // Sin enlace elegido se reparte el origen actual, e importa decir dónde está
  // el servidor si la app no se sirve desde él.
  if (normalizeUrl(conn.url) !== origin) params.set('s', conn.url)
  return `${origin}/#${params.toString()}`
}

/** ¿Sirve este origen para repartirlo? `localhost` y las IP privadas no. */
export function isShareable(url: string): boolean {
  try {
    const host = new URL(normalizeUrl(url)).hostname
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false
    // Las de LAN sirven dentro de casa, pero no fuera: se avisa aparte.
    return true
  } catch {
    return false
  }
}

export function isLanOnly(url: string): boolean {
  try {
    const host = new URL(normalizeUrl(url)).hostname
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  } catch {
    return false
  }
}

/** Lee la invitación de la URL actual y la borra de la barra de direcciones. */
export function consumeInviteFromUrl(): Connection | null {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash.replace(/^#/, '')
  if (!hash) return null

  let params: URLSearchParams
  try {
    params = new URLSearchParams(hash)
  } catch {
    return null
  }

  const token = params.get('t')
  if (!token) return null

  const url = normalizeUrl(params.get('s') || window.location.origin)
  // `replaceState` en vez de asignar `location.hash`: no añade entrada al
  // historial, así que el botón «atrás» no devuelve el token a la barra.
  window.history.replaceState(null, '', window.location.pathname + window.location.search)

  return { url, token }
}

/**
 * Mensaje que acompaña al enlace. Se separa del enlace porque `navigator.share`
 * los manda como campos distintos: `text` + `url`. Cuando no hay API de
 * compartir se copian juntos.
 */
export function buildInviteMessage(input: {
  link: string
  /** Nombre de quien recibe. Ausente cuando es tu propio acceso. */
  name?: string
  from?: string
}): { title: string; text: string; full: string } {
  const own = !input.name

  const title = own ? 'Mi acceso a Claude Remote' : `Acceso a Claude Remote para ${input.name}`

  const text = own
    ? [
        'Mi acceso a Claude Remote.',
        '',
        'Al abrir el enlace entro directo, sin escribir nada.',
        'En el móvil conviene «Añadir a pantalla de inicio» para tenerlo como app.',
        '',
        'El enlace es la credencial: si se filtra, roto el token desde el panel.',
      ].join('\n')
    : [
        `Te doy acceso a Claude Remote${input.from ? ` (te invita ${input.from})` : ''}.`,
        'Es un portal para trabajar con Claude Code sobre los proyectos, desde el móvil.',
        '',
        'Abre el enlace y entras directo: ya lleva tu acceso, no hay que copiar ni escribir nada.',
        'En el móvil, usa «Añadir a pantalla de inicio» para tenerlo como una app.',
        '',
        'Ese enlace es tu credencial personal: no lo reenvíes a nadie.',
      ].join('\n')

  return { title, text, full: `${text}\n\n${input.link}` }
}
