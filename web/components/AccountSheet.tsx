'use client'

import { formatCost } from '@/lib/items'
import { useStore } from '@/lib/store'
import { IconLogout } from './Icons'
import { ShareInvite } from './ShareInvite'
import { Sheet } from './Sheet'

/**
 * Cuenta propia. El enlace se arma con el token que la app ya tiene en memoria,
 * así que abrir tu acceso en otro dispositivo no pasa por el servidor ni crea
 * credenciales nuevas: es el mismo token.
 */
export function AccountSheet({ onClose }: { onClose: () => void }) {
  const { me, conn, defaults, disconnect } = useStore()
  if (!me || !conn) return null

  const limit = me.limits.monthlyUsd

  return (
    <Sheet title={me.name} onClose={onClose}>
      <div className="field">
        <label>Consumo del mes</label>
        <span className="field-hint">
          {formatCost(me.usage.monthUsd)}
          {limit != null ? ` de ${formatCost(limit)}` : ' · sin tope'} · {me.usage.monthTurns} turnos ·{' '}
          {me.projectCount} proyectos
        </span>
        {limit != null && (
          <span className="usage-bar wide" aria-hidden>
            <i
              style={{ width: `${Math.min(100, Math.round((me.usage.monthUsd / limit) * 100))}%` }}
              className={me.usage.monthUsd / limit > 0.85 ? 'hot' : ''}
            />
          </span>
        )}
      </div>

      <div className="field">
        <label>Abrir en otro dispositivo</label>
        <span className="field-hint">
          Mándate este enlace y ábrelo en la tablet o el portátil: entra directo con tu misma cuenta.
        </span>
      </div>

      <ShareInvite token={conn.token} />

      <div className="field">
        <label>Servidor</label>
        <span className="field-hint mono">{conn.url}</span>
        {defaults && <span className="field-hint mono">{defaults.workspace}</span>}
      </div>

      <button
        className="btn ghost block"
        onClick={() => {
          disconnect()
          onClose()
        }}
      >
        <span className="row-center">
          <IconLogout /> Cerrar sesión en este dispositivo
        </span>
      </button>
    </Sheet>
  )
}
