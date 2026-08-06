import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { HttpError } from './auth.js'
import { config } from './config.js'
import { seedKnowledge } from './knowledge.js'
import { loadProjects, saveProjects } from './store.js'
import type { ModelRoles, Project, TreeNode, User } from './types.js'

const IGNORED = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  '.venv',
  '__pycache__',
  '.DS_Store',
  '.turbo',
  'target',
])

/**
 * Los usuarios no eligen rutas: piden un proyecto y el servidor crea la
 * carpeta dentro del workspace. Esto es lo que hace acotable el acceso — toda
 * ruta que se sirva se valida contra la raíz antes de tocar el disco.
 */
export class Projects {
  private projects: Project[]

  constructor() {
    // Los proyectos creados antes de que existieran los roles de modelo se
    // completan al cargar, para no tener que comprobar `?? default` en todas partes.
    this.projects = loadProjects().map((p) => ({
      ...p,
      models: { ...defaultModels(), ...(p.models ?? {}) },
      rules: p.rules ?? '',
      autoApprove: p.autoApprove ?? false,
    }))
  }

  private persist() {
    saveProjects(this.projects)
  }

  list(user: User): Project[] {
    const visible = user.role === 'admin' ? this.projects : this.projects.filter((p) => p.ownerId === user.id)
    return [...visible].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  all(): Project[] {
    return this.projects
  }

  get(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id)
  }

  /** Lanza 404 si no existe y 403 si no es suyo (el admin ve todo). */
  require(id: string, user: User): Project {
    const project = this.get(id)
    if (!project) throw new HttpError(404, 'Proyecto no encontrado.')
    if (user.role !== 'admin' && project.ownerId !== user.id) {
      throw new HttpError(403, 'Ese proyecto no es tuyo.')
    }
    return project
  }

  countFor(userId: string): number {
    return this.projects.filter((p) => p.ownerId === userId).length
  }

  create(user: User, input: { name: string; description?: string }): Project {
    const name = input.name.trim()
    if (!name) throw new HttpError(400, 'El nombre del proyecto es obligatorio.')

    const max = user.limits.maxProjects
    if (max !== null && this.countFor(user.id) >= max) {
      throw new HttpError(403, `Alcanzaste tu límite de ${max} proyectos.`)
    }

    const slug = this.uniqueSlug(slugify(name))
    const dir = join(config.workspace, slug)
    mkdirSync(dir, { recursive: true })

    const now = Date.now()
    const project: Project = {
      id: randomUUID(),
      slug,
      name,
      description: input.description?.trim() ?? '',
      ownerId: user.id,
      dir,
      createdAt: now,
      updatedAt: now,
      summary: null,
      summaryUpdatedAt: null,
      autoKnowledge: true,
      knowledgeEntries: 0,
      models: defaultModels(),
      rules: '',
      autoApprove: false,
    }

    seedKnowledge(project)
    writeProjectGuide(project)

    this.projects.push(project)
    this.persist()
    return project
  }

  update(
    project: Project,
    patch: {
      name?: string
      description?: string
      autoKnowledge?: boolean
      models?: Partial<ModelRoles>
      rules?: string
      autoApprove?: boolean
    },
  ): Project {
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw new HttpError(400, 'El nombre no puede quedar vacío.')
      project.name = name
    }
    if (patch.description !== undefined) project.description = patch.description.trim()
    if (patch.autoKnowledge !== undefined) project.autoKnowledge = patch.autoKnowledge
    if (patch.rules !== undefined) project.rules = String(patch.rules).slice(0, 8000)
    if (patch.autoApprove !== undefined) project.autoApprove = patch.autoApprove
    if (patch.models) {
      const models = { ...project.models }
      if (patch.models.main) models.main = patch.models.main
      for (const role of ['plan', 'rules', 'knowledge'] as const) {
        if (role in patch.models) models[role] = patch.models[role] || null
      }
      project.models = models
    }
    // Auto-aprobar sin reglas escritas dejaría al evaluador decidiendo a ciegas.
    if (project.autoApprove && !project.rules.trim()) {
      throw new HttpError(400, 'Escribe las reglas antes de activar la auto-aprobación.')
    }
    project.updatedAt = Date.now()
    this.persist()
    return project
  }

  touch(projectId: string) {
    const project = this.get(projectId)
    if (!project) return
    project.updatedAt = Date.now()
    this.persist()
  }

  save() {
    this.persist()
  }

  /** Da de baja el proyecto pero NUNCA borra archivos: la carpeta queda en el workspace. */
  remove(id: string) {
    this.projects = this.projects.filter((p) => p.id !== id)
    this.persist()
  }

  private uniqueSlug(base: string): string {
    let slug = base
    let n = 2
    while (this.projects.some((p) => p.slug === slug) || existsSync(join(config.workspace, slug))) {
      slug = `${base}-${n++}`
    }
    return slug
  }
}

export function defaultModels(): ModelRoles {
  return { main: config.defaultModel, plan: null, rules: config.knowledgeModel, knowledge: config.knowledgeModel }
}

export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'proyecto'
}

/**
 * Verifica que una ruta esté realmente dentro de la carpeta del proyecto.
 * Se compara sobre la ruta ya resuelta, así que `..` y symlinks no escapan.
 */
export function assertInsideProject(project: Project, target: string): string {
  const root = resolve(project.dir)
  const full = resolve(root, target)
  const rel = relative(root, full)
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(full) === resolve(root, '..')) {
    throw new HttpError(403, 'Ruta fuera del proyecto.')
  }
  return full
}

/** Árbol de la carpeta del proyecto, acotado en profundidad y en número de hijos. */
export function readTree(project: Project, maxDepth = 4, maxChildren = 200): TreeNode {
  const walk = (dir: string, depth: number): TreeNode => {
    const node: TreeNode = {
      name: dir === project.dir ? project.slug : dir.split(sep).pop()!,
      path: relative(project.dir, dir) || '.',
      type: 'dir',
      children: [],
    }
    if (depth >= maxDepth) {
      node.truncated = true
      return node
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      node.truncated = true
      return node
    }
    // Ocultar dotfiles y carpetas de build no es "recortar": el aviso de
    // truncado solo aparece si de verdad se dejaron entradas fuera por el tope.
    const relevant = entries.filter((e) => !IGNORED.has(e.name) && !e.name.startsWith('.'))
    const visible = relevant.slice(0, maxChildren)
    if (visible.length < relevant.length) node.truncated = true

    for (const entry of visible.sort(sortEntries)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        node.children!.push(walk(full, depth + 1))
      } else if (entry.isFile()) {
        let size: number | undefined
        let mtimeMs: number | undefined
        try {
          const stat = statSync(full)
          size = stat.size
          mtimeMs = stat.mtimeMs
        } catch {
          size = undefined
        }
        node.children!.push({
          name: entry.name,
          path: relative(project.dir, full),
          type: 'file',
          size,
          mtimeMs,
        })
      }
    }
    return node
  }

  return walk(project.dir, 0)
}

function sortEntries(a: { name: string; isDirectory(): boolean }, b: { name: string; isDirectory(): boolean }) {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
  return a.name.localeCompare(b.name)
}

/**
 * CLAUDE.md dentro del proyecto: es lo que hace que el agente lea su propio
 * knowledge al arrancar en vez de empezar de cero cada sesión.
 */
function writeProjectGuide(project: Project) {
  const file = join(project.dir, 'CLAUDE.md')
  if (existsSync(file)) return
  writeFileSync(
    file,
    [
      `# ${project.name}`,
      '',
      project.description || '_Sin descripción todavía._',
      '',
      '## Knowledge del proyecto',
      '',
      'Antes de empezar una tarea, lee `.knowledge/KNOWLEDGE.md`: contiene el estado',
      'actual, las decisiones tomadas y lo que quedó pendiente. El historial por',
      'fechas está en `.knowledge/history/`.',
      '',
      'No edites esos archivos a mano: los mantiene Claude Remote al cerrar cada sesión.',
      '',
    ].join('\n'),
  )
}
