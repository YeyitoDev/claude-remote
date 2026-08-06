/**
 * Registra o actualiza un enlace de acceso remoto desde la terminal.
 *
 * Lo usa `start.sh` para dar de alta la URL del túnel en cuanto aparece: los
 * quick tunnels cambian de dirección en cada arranque, y sin esto habría que
 * entrar al panel a corregirla a mano cada vez.
 *
 *   npm run set-link -- https://algo.trycloudflare.com ["Etiqueta"]
 *
 * Escribe directamente en `links.json`, así que **el servidor debe estar
 * parado o arrancar después**: si está vivo, su copia en memoria pisará esto.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { config } from './config.js'
import { loadLinks } from './store.js'
import type { AccessLink } from './types.js'

const raw = process.argv[2]?.trim()
const label = process.argv[3]?.trim()

if (!raw) {
  console.error('Uso: npm run set-link -- <url> ["Etiqueta"]')
  process.exit(1)
}

let origin: string
try {
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocolo')
  origin = url.origin
} catch {
  console.error(`No es una dirección válida: ${raw}`)
  process.exit(1)
}

const links = loadLinks()
const existing = links.find((l) => l.url === origin)

if (existing) {
  if (label) existing.label = label
  for (const other of links) other.primary = other === existing
  console.log(`Enlace ya registrado, ahora es el principal: ${origin}`)
} else {
  for (const other of links) other.primary = false
  const link: AccessLink = {
    id: randomUUID(),
    label: label || guessLabel(origin),
    url: origin,
    note: '',
    primary: true,
    createdAt: Date.now(),
  }
  links.push(link)
  console.log(`Enlace registrado como principal: ${link.label} → ${origin}`)
}

// Los quick tunnels anteriores están muertos por definición: cada arranque de
// `cloudflared` genera una URL nueva. Se podan para que la lista no crezca sin
// fin. Solo se tocan los `trycloudflare.com`: un tunnel con nombre usa dominio
// propio y una LAN o un Tailscale siguen siendo válidos.
const kept = links.filter((l) => l.url === origin || !l.url.includes('trycloudflare.com'))
const pruned = links.length - kept.length
if (pruned > 0) console.log(`  Se descartaron ${pruned} túnel(es) anteriores, ya caducados.`)

writeFileSync(config.linksFile, JSON.stringify(kept, null, 2))
if (!existsSync(config.linksFile)) {
  console.error('No se pudo escribir el archivo de enlaces.')
  process.exit(1)
}

function guessLabel(url: string): string {
  const host = new URL(url).hostname
  if (host.endsWith('trycloudflare.com')) return 'Túnel Cloudflare'
  if (host.endsWith('.ts.net')) return 'Tailscale'
  if (host === 'localhost' || host === '127.0.0.1') return 'Local'
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'Red local'
  return host
}
