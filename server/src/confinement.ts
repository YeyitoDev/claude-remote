import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'

/**
 * Confinamiento del agente a la carpeta de su proyecto.
 *
 * Se implementa como hook `PreToolUse` y no dentro de `canUseTool` a propósito:
 * `canUseTool` no llega a invocarse en `bypassPermissions`, mientras que un
 * PreToolUse que deniega corta la herramienta en cualquier modo de permisos.
 * Es el único punto donde el límite se cumple siempre.
 */

/** Campos de las herramientas del SDK que llevan una ruta de archivo. */
const PATH_FIELDS = [
  'file_path',
  'path',
  'notebook_path',
  'target_file',
  'destination',
  'cwd',
  'directory',
]

/** Rutas del sistema que no deben tocarse aunque alguien monte el proyecto cerca. */
const ALWAYS_DENY = [/^\/etc\//, /^\/System\//, /^\/private\/etc\//, /\/\.ssh(\/|$)/, /\/\.aws(\/|$)/]

export type Confinement = { allowed: boolean; reason?: string }

/** ¿La ruta cae dentro de la carpeta del proyecto? */
export function insideRoot(root: string, candidate: string): boolean {
  const base = resolve(root)
  const full = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate)
  const rel = relative(base, full)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Revisa la entrada de una herramienta y devuelve la primera violación.
 *
 * Para Bash la comprobación es textual y deliberadamente amplia: no se puede
 * saber qué toca un comando sin ejecutarlo, así que se rechaza cualquier ruta
 * absoluta ajena, cualquier `~` y cualquier `cd` que salga del proyecto. Es
 * conservador y ese es el punto — un falso positivo cuesta un mensaje, un
 * falso negativo cuesta archivos fuera del proyecto.
 */
export function checkToolPaths(root: string, toolName: string, input: unknown): Confinement {
  if (!input || typeof input !== 'object') return { allowed: true }
  const record = input as Record<string, unknown>

  for (const field of PATH_FIELDS) {
    const value = record[field]
    if (typeof value !== 'string' || !value) continue
    if (ALWAYS_DENY.some((re) => re.test(value))) {
      return { allowed: false, reason: `la ruta ${value} está fuera de límites` }
    }
    if (!insideRoot(root, value)) {
      return { allowed: false, reason: `${field}="${value}" está fuera de la carpeta del proyecto` }
    }
  }

  if (toolName === 'Bash' && typeof record.command === 'string') {
    const violation = scanCommand(root, record.command)
    if (violation) return { allowed: false, reason: violation }
  }

  return { allowed: true }
}

function scanCommand(root: string, command: string): string | null {
  if (/(^|\s)cd\s+(\/|~)/.test(command)) {
    const target = command.match(/(^|\s)cd\s+(\S+)/)?.[2] ?? ''
    const expanded = target.replace(/^~/, process.env.HOME ?? '~')
    if (!insideRoot(root, expanded)) return `el comando hace "cd" fuera del proyecto (${target})`
  }

  for (const token of command.split(/[\s'"();|&<>]+/)) {
    if (!token) continue
    if (ALWAYS_DENY.some((re) => re.test(token))) return `el comando referencia ${token}`
    if (token.startsWith('~')) return `el comando usa una ruta del home (${token})`
    if (token.startsWith('/') && token.length > 1) {
      // Los binarios del sistema son rutas absolutas legítimas (/bin/ls, /usr/bin/git).
      if (/^\/(usr|bin|sbin|opt|Library|Applications)\//.test(token) || /^\/(bin|usr)$/.test(token)) continue
      if (!insideRoot(root, token)) return `el comando referencia la ruta absoluta ${token}`
    }
    if (token.includes('..') && !insideRoot(root, token)) {
      return `el comando sale del proyecto con ${token}`
    }
  }

  return null
}

/**
 * Hook listo para pasar a `options.hooks.PreToolUse`. Deniega en cualquier
 * modo de permisos, incluido `bypassPermissions`.
 */
export function confinementHook(root: string, onDeny: (reason: string, toolName: string) => void) {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const verdict = checkToolPaths(root, input.tool_name, input.tool_input)
    if (verdict.allowed) return {}

    onDeny(verdict.reason ?? 'ruta fuera del proyecto', input.tool_name)
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Bloqueado: ${verdict.reason}. Esta sesión solo puede tocar archivos dentro de ${root}. ` +
          'Reformula la acción con una ruta relativa dentro del proyecto.',
      },
    }
  }
}
