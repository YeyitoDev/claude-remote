import type { PermissionMode } from './types'

/** Catálogo único: antes estaba duplicado en cuatro componentes. */
export const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5', hint: 'El más capaz. Para trabajo difícil y largo.' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: 'Casi Opus en código, bastante más barato.' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', hint: 'Rápido y económico. Para tareas simples.' },
] as const

export const MODES: { id: PermissionMode; label: string; hint: string; risky?: boolean }[] = [
  { id: 'default', label: 'Preguntar', hint: 'Cada acción sensible te pide permiso.' },
  { id: 'acceptEdits', label: 'Auto-editar', hint: 'Acepta ediciones de archivos sin preguntar.' },
  { id: 'plan', label: 'Plan', hint: 'Solo planifica, no ejecuta herramientas.' },
  {
    id: 'bypassPermissions',
    label: 'Sin permisos',
    hint: 'Ejecuta todo sin preguntar. Solo donde no te importe el daño.',
    risky: true,
  },
]

export function modelLabel(id: string): string {
  const known = MODELS.find((m) => m.id === id)
  if (known) return known.label
  // Modelo desconocido (p. ej. configurado por env): se acorta el id.
  return id
    .replace(/^claude-/, '')
    .replace(/-(\d)-(\d)$/, ' $1.$2')
    .replace(/-(\d)$/, ' $1')
}

export function modeLabel(id: PermissionMode): string {
  return MODES.find((m) => m.id === id)?.label ?? id
}
