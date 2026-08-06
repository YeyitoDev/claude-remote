'use client'

import { useEffect, type ReactNode } from 'react'
import { IconClose } from './Icons'

/** Bottom sheet: el patrón de overlay que funciona con el pulgar en móvil. */
export function Sheet({
  title,
  onClose,
  children,
  action,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  action?: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h2>{title}</h2>
          {action}
          <button className="icon-button" onClick={onClose} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </>
  )
}
