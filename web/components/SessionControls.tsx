'use client'

import { useState } from 'react'
import { MODELS, MODES, modeLabel, modelLabel } from '@/lib/models'
import { useStore } from '@/lib/store'
import type { PermissionMode, SessionView } from '@/lib/types'
import { Sheet } from './Sheet'

type Picker = 'model' | 'mode' | null

/**
 * Modelo y modo de permisos al alcance del pulgar, sobre el campo de texto.
 * Ambos se aplican en caliente sin reiniciar la sesión, así que se puede
 * planificar con Opus y ejecutar con Sonnet dentro de la misma conversación.
 */
export function SessionControls({ session }: { session: SessionView }) {
  const { updateSession } = useStore()
  const [picker, setPicker] = useState<Picker>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const mode = MODES.find((m) => m.id === session.permissionMode)

  const apply = async (patch: { model?: string; permissionMode?: PermissionMode }) => {
    setBusy(true)
    setFailure(null)
    try {
      await updateSession(session.id, patch)
      setPicker(null)
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo cambiar.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="controls">
        <button className="control" onClick={() => setPicker('model')} disabled={busy}>
          <span className="control-label">Modelo</span>
          <span className="control-value">{modelLabel(session.model)}</span>
        </button>

        <button
          className={`control${mode?.risky ? ' risky' : ''}`}
          onClick={() => setPicker('mode')}
          disabled={busy}
        >
          <span className="control-label">Permisos</span>
          <span className="control-value">{modeLabel(session.permissionMode)}</span>
        </button>

        {failure && <span className="control-error">{failure}</span>}
      </div>

      {picker === 'model' && (
        <Sheet title="Modelo de la sesión" onClose={() => setPicker(null)}>
          {MODELS.map((m) => (
            <button
              key={m.id}
              className={`option${session.model === m.id ? ' on' : ''}`}
              onClick={() => void apply({ model: m.id })}
              disabled={busy}
            >
              <span className="option-title">{m.label}</span>
              <span className="option-hint">{m.hint}</span>
            </button>
          ))}
          <span className="field-hint">
            Se aplica al turno siguiente. Cambiar de modelo reinicia la caché de prompt, así que el primer
            mensaje después del cambio cuesta un poco más.
          </span>
        </Sheet>
      )}

      {picker === 'mode' && (
        <Sheet title="Permisos de la sesión" onClose={() => setPicker(null)}>
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`option${session.permissionMode === m.id ? ' on' : ''}${m.risky ? ' risky' : ''}`}
              onClick={() => void apply({ permissionMode: m.id })}
              disabled={busy}
            >
              <span className="option-title">{m.label}</span>
              <span className="option-hint">{m.hint}</span>
            </button>
          ))}
          <span className="field-hint">
            En modo Plan se usa el modelo de planificación del proyecto, si tiene uno distinto configurado.
          </span>
        </Sheet>
      )}
    </>
  )
}
