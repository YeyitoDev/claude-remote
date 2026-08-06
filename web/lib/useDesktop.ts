'use client'

import { useEffect, useState } from 'react'

/** A partir de aquí cabe el panel lateral fijo junto a la conversación. */
const DESKTOP = '(min-width: 900px)'

/**
 * Se resuelve en un efecto, no durante el render: el HTML es estático
 * (`output: 'export'`) y leer `matchMedia` en el primer render provocaría un
 * desajuste de hidratación.
 */
export function useDesktop(): boolean {
  const [desktop, setDesktop] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP)
    const update = () => setDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  return desktop
}

const KEY = 'claude-remote.sidebar'

/** Recuerda si el panel fijo quedó abierto o cerrado entre visitas. */
export function useDockedPreference(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(true)

  useEffect(() => {
    setOpen(window.localStorage.getItem(KEY) !== 'hidden')
  }, [])

  const persist = (next: boolean) => {
    setOpen(next)
    window.localStorage.setItem(KEY, next ? 'shown' : 'hidden')
  }

  return [open, persist]
}
