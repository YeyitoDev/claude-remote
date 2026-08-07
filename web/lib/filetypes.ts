/**
 * Clasificación de archivos por para qué sirven, no por su mime.
 *
 * Un proyecto con un entorno de Python o una carpeta de scripts entierra los
 * dos documentos que su dueño quiere leer. El filtro existe para eso: quien usa
 * la app desde el celular casi siempre busca "el documento", no el código.
 */

export type FileGroup = 'documento' | 'imagen' | 'codigo' | 'datos' | 'otro'

export type FileFilter = 'todos' | FileGroup

const DOCUMENTO = new Set([
  '.docx', '.doc', '.pdf', '.md', '.markdown', '.txt', '.rtf', '.odt',
  '.pptx', '.ppt', '.odp', '.pages', '.epub',
])

const IMAGEN = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.heic', '.bmp', '.ico', '.tif', '.tiff'])

const DATOS = new Set(['.csv', '.tsv', '.xlsx', '.xls', '.ods', '.json', '.jsonl', '.xml', '.yml', '.yaml', '.sql', '.db', '.sqlite'])

const CODIGO = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.html', '.sh', '.bash',
  '.zsh', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.swift',
  '.toml', '.ini', '.cfg', '.lock', '.pyc', '.ipynb',
])

export function extensionOf(name: string): string {
  const match = name.toLowerCase().match(/\.[^./\\]+$/)
  return match ? match[0] : ''
}

export function groupOf(name: string): FileGroup {
  const ext = extensionOf(name)
  if (DOCUMENTO.has(ext)) return 'documento'
  if (IMAGEN.has(ext)) return 'imagen'
  // Los datos se miran antes que el código: un `.json` es más dato que fuente,
  // y quien filtra por código no lo está buscando.
  if (DATOS.has(ext)) return 'datos'
  if (CODIGO.has(ext)) return 'codigo'
  return 'otro'
}

export function matches(name: string, filter: FileFilter): boolean {
  return filter === 'todos' || groupOf(name) === filter
}

export const FILTERS: { id: FileFilter; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'documento', label: 'Documentos' },
  { id: 'imagen', label: 'Imágenes' },
  { id: 'datos', label: 'Datos' },
  { id: 'codigo', label: 'Código' },
]

const KEY = 'claude-remote.files.filter'

export function loadFilter(): FileFilter {
  if (typeof window === 'undefined') return 'todos'
  const raw = window.localStorage.getItem(KEY)
  return FILTERS.some((f) => f.id === raw) ? (raw as FileFilter) : 'todos'
}

export function saveFilter(filter: FileFilter) {
  if (typeof window !== 'undefined') window.localStorage.setItem(KEY, filter)
}

/**
 * Poda el árbol dejando solo lo que pasa el filtro.
 *
 * Las carpetas que se quedan sin nada dentro desaparecen: si no, filtrar por
 * "documentos" en un proyecto con código deja una lista de carpetas vacías que
 * es peor que no filtrar.
 */
export function pruneTree<T extends { name: string; type: 'dir' | 'file'; children?: T[] }>(
  node: T,
  filter: FileFilter,
): T | null {
  if (filter === 'todos') return node
  if (node.type === 'file') return matches(node.name, filter) ? node : null

  const children = (node.children ?? [])
    .map((child) => pruneTree(child, filter))
    .filter((child): child is T => child !== null)

  if (!children.length) return null
  return { ...node, children }
}

export function countFiles<T extends { type: 'dir' | 'file'; children?: T[] }>(node: T | null): number {
  if (!node) return 0
  if (node.type === 'file') return 1
  return (node.children ?? []).reduce((sum, child) => sum + countFiles(child), 0)
}
