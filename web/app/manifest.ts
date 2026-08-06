import type { MetadataRoute } from 'next'

// Requerido por `output: 'export'`: el manifest se emite como archivo estático.
export const dynamic = 'force-static'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Claude Remote',
    short_name: 'Claude',
    description: 'Sesiones remotas de Claude Code desde el celular',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0b0c0e',
    theme_color: '#0b0c0e',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
