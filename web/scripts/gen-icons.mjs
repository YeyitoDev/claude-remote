// Genera los iconos PNG de la PWA sin dependencias: se dibuja el bitmap a mano
// y se codifica con zlib, que ya viene en Node. Ejecutar con `npm run icons`.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'public')
mkdirSync(outDir, { recursive: true })

const BG = [11, 12, 14, 255]
const ACCENT = [217, 119, 87, 255]

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filtro "none"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Icono: fondo oscuro completo (maskable-friendly) + chevron ">" y guion bajo en acento. */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    px[i] = color[0]
    px[i + 1] = color[1]
    px[i + 2] = color[2]
    px[i + 3] = color[3]
  }

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG)

  const s = size / 24 // lienzo lógico de 24 unidades
  const thick = Math.max(2, Math.round(2.2 * s))

  // Chevron ">" formado por dos segmentos diagonales.
  const segment = (x0, y0, x1, y1) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const cx = Math.round(x0 + (x1 - x0) * t)
      const cy = Math.round(y0 + (y1 - y0) * t)
      for (let dy = -thick / 2; dy <= thick / 2; dy++) {
        for (let dx = -thick / 2; dx <= thick / 2; dx++) {
          if (dx * dx + dy * dy <= (thick / 2) * (thick / 2)) set(cx + Math.round(dx), cy + Math.round(dy), ACCENT)
        }
      }
    }
  }

  segment(7 * s, 7 * s, 12.5 * s, 12 * s)
  segment(12.5 * s, 12 * s, 7 * s, 17 * s)

  // Guion bajo del prompt.
  for (let y = Math.round(15.6 * s); y < Math.round(15.6 * s) + thick; y++) {
    for (let x = Math.round(14 * s); x < Math.round(19 * s); x++) set(x, y, ACCENT)
  }

  return encodePng(size, size, px)
}

for (const size of [192, 512]) {
  const file = join(outDir, `icon-${size}.png`)
  writeFileSync(file, drawIcon(size))
  console.log('escrito', file)
}
