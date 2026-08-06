import type { Metadata, Viewport } from 'next'
import { StoreProvider } from '@/lib/store'
import { ServiceWorker } from '@/components/ServiceWorker'
import './globals.css'

export const metadata: Metadata = {
  title: 'Claude Remote',
  description: 'Sesiones remotas de Claude Code desde el celular',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Claude Remote' },
  icons: { icon: '/icon-192.png', apple: '/icon-192.png' },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b0c0e' },
    { media: '(prefers-color-scheme: light)', color: '#f7f6f4' },
  ],
  width: 'device-width',
  initialScale: 1,
  // Sin zoom: la app es una superficie de chat, no un documento.
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <StoreProvider>{children}</StoreProvider>
        <ServiceWorker />
      </body>
    </html>
  )
}
