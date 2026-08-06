'use client'

import { useEffect } from 'react'

/**
 * Registra el service worker que hace instalable la PWA. Solo cachea el
 * app shell: los datos siempre vienen del servidor por REST/WS, así que no
 * hay riesgo de mostrar una conversación obsoleta desde caché.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') return
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  }, [])
  return null
}
