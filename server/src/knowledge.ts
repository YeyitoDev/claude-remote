import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { config } from './config.js'
import type { KnowledgeEntry, KnowledgeView, Project, StoredEvent } from './types.js'

/**
 * Knowledge del proyecto.
 *
 * Dos representaciones del mismo contenido, escritas a la vez:
 *  - `entries.jsonl` — fuente de verdad para la app (parsear markdown es frágil).
 *  - `history/YYYY-MM-DD.md` + `KNOWLEDGE.md` — para que el propio agente los
 *    lea con Read/Grep en la siguiente sesión, que es la mitad del valor.
 */

const dirOf = (project: Project) => join(project.dir, '.knowledge')
const entriesFile = (project: Project) => join(dirOf(project), 'entries.jsonl')
const summaryFile = (project: Project) => join(dirOf(project), 'KNOWLEDGE.md')
const historyDir = (project: Project) => join(dirOf(project), 'history')
const dayFile = (project: Project, date: string) => join(historyDir(project), `${date}.md`)

export function seedKnowledge(project: Project) {
  mkdirSync(historyDir(project), { recursive: true })
  if (!existsSync(summaryFile(project))) {
    writeFileSync(
      summaryFile(project),
      [
        `# ${project.name}`,
        '',
        '> Resumen mantenido automáticamente por Claude Remote.',
        '> Todavía no hay sesiones: se llenará al cerrar la primera.',
        '',
      ].join('\n'),
    )
  }
}

// ------------------------------------------------------------------ lectura

export async function readKnowledge(project: Project): Promise<KnowledgeView> {
  const file = entriesFile(project)
  const entries: KnowledgeEntry[] = []

  if (existsSync(file)) {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line) continue
      try {
        entries.push(JSON.parse(line) as KnowledgeEntry)
      } catch {
        // línea corrupta: se salta
      }
    }
    rl.close()
  }

  const byDate = new Map<string, KnowledgeEntry[]>()
  for (const entry of entries) {
    const bucket = byDate.get(entry.date) ?? []
    bucket.push(entry)
    byDate.set(entry.date, bucket)
  }

  const days = [...byDate.entries()]
    .map(([date, list]) => ({ date, entries: list.sort((a, b) => b.ts - a.ts) }))
    .sort((a, b) => b.date.localeCompare(a.date))

  return {
    summary: project.summary,
    summaryUpdatedAt: project.summaryUpdatedAt,
    days,
    totalEntries: entries.length,
  }
}

export function readSummaryMarkdown(project: Project): string {
  const file = summaryFile(project)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

// ---------------------------------------------------------------- escritura

export function appendEntry(project: Project, entry: KnowledgeEntry) {
  mkdirSync(historyDir(project), { recursive: true })
  appendFileSync(entriesFile(project), JSON.stringify(entry) + '\n')

  const file = dayFile(project, entry.date)
  if (!existsSync(file)) writeFileSync(file, `# ${entry.date}\n`)
  appendFileSync(
    file,
    [
      '',
      `## ${entry.time} · ${entry.sessionTitle} · ${entry.userName}${entry.manual ? ' · nota manual' : ''}`,
      '',
      entry.content.trim(),
      '',
    ].join('\n'),
  )

  project.knowledgeEntries += 1
  project.updatedAt = Date.now()
}

function writeSummaryMarkdown(project: Project, summary: string) {
  writeFileSync(
    summaryFile(project),
    [
      `# ${project.name}`,
      '',
      `> Resumen automático · actualizado ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      `> Historial completo por fechas en \`.knowledge/history/\`.`,
      '',
      summary.trim(),
      '',
    ].join('\n'),
  )
}

// --------------------------------------------------------------- generación

const ENTRY_PROMPT = `Eres el archivista de un proyecto de software. Resume la sesión que sigue para que otra persona (u otro agente) pueda retomar el trabajo dentro de un mes sin leer la transcripción.

Formato exacto, en español, sin preámbulo ni cierre:

**Hecho**
- (qué cambió de verdad: archivos, funciones, comandos ejecutados con su resultado)

**Decidido**
- (decisiones técnicas y el porqué; omite la sección entera si no hubo)

**Pendiente**
- (lo que quedó a medias o falta; omite la sección entera si no hay)

Reglas:
- Máximo 8 viñetas en total. Si algo no cambia lo que alguien haría después, no va.
- Nombra archivos, comandos y símbolos concretos. Nada de "se mejoró el código".
- Nada de relleno, cortesías ni repetir la petición del usuario.
- Si la sesión no produjo nada sustancial, responde exactamente: SIN_CAMBIOS

Transcripción:
`

const SUMMARY_PROMPT = `Eres el archivista de un proyecto de software. Reescribe el resumen vivo del proyecto a partir del resumen anterior y de las entradas nuevas del historial.

Formato exacto, en español, markdown, sin preámbulo:

## Qué es
(2-3 frases: qué hace el proyecto y para quién)

## Estado actual
- (dónde está hoy: qué funciona, qué está a medias)

## Decisiones
- (decisiones vigentes y su motivo; las que fueron revertidas no van)

## Pendiente
- (lo siguiente que habría que hacer)

Reglas:
- Máximo 14 viñetas en total. Es un resumen vivo, no un changelog: funde lo repetido y borra lo que ya no aplica.
- Concreto: nombres de archivos, comandos, decisiones. Nada de generalidades.
- Sin fechas en las viñetas (para eso está el historial).
`

/** Llama al modelo barato sin herramientas y devuelve texto + coste. */
async function runPrompt(project: Project, prompt: string): Promise<{ text: string; costUsd: number }> {
  let text = ''
  let costUsd = 0
  const response = query({
    prompt,
    options: {
      cwd: project.dir,
      model: project.models.knowledge ?? config.knowledgeModel,
      // Sin herramientas ni settings del usuario: esto solo resume texto.
      tools: [],
      settingSources: [],
      maxTurns: 1,
      // Tope duro: un resumen que se desmadre no puede vaciar el presupuesto.
      maxBudgetUsd: 0.25,
    },
  })

  for await (const message of response) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') text += block.text
      }
    } else if (message.type === 'result') {
      costUsd = message.total_cost_usd ?? 0
    }
  }

  return { text: text.trim(), costUsd }
}

/** Convierte los eventos de un turno en una transcripción compacta para resumir. */
export function condenseEvents(events: StoredEvent[], maxChars = 14_000): string {
  const lines: string[] = []
  for (const event of events) {
    switch (event.kind) {
      case 'user':
        lines.push(`USUARIO: ${event.text}`)
        break
      case 'assistant':
        lines.push(`CLAUDE: ${event.text}`)
        break
      case 'tool_use':
        lines.push(`HERRAMIENTA ${event.name}: ${JSON.stringify(event.input).slice(0, 400)}`)
        break
      case 'tool_result':
        lines.push(`RESULTADO${event.isError ? ' (error)' : ''}: ${event.text.slice(0, 400)}`)
        break
      default:
        break
    }
  }
  const text = lines.join('\n')
  // Se conserva el final, que es donde está el desenlace de la sesión.
  return text.length <= maxChars ? text : `…(recortado)…\n${text.slice(-maxChars)}`
}

export async function generateEntry(
  project: Project,
  input: { transcript: string; sessionId: string; sessionTitle: string; userName: string },
): Promise<{ entry: KnowledgeEntry | null; costUsd: number }> {
  if (!input.transcript.trim()) return { entry: null, costUsd: 0 }

  const { text, costUsd } = await runPrompt(project, ENTRY_PROMPT + input.transcript)
  if (!text || text.includes('SIN_CAMBIOS')) return { entry: null, costUsd }

  const now = new Date()
  const entry: KnowledgeEntry = {
    date: toLocalDate(now),
    time: toLocalTime(now),
    sessionId: input.sessionId,
    sessionTitle: input.sessionTitle,
    userName: input.userName,
    content: text,
    ts: now.getTime(),
    manual: false,
  }
  appendEntry(project, entry)
  return { entry, costUsd }
}

export function addManualEntry(
  project: Project,
  input: { content: string; sessionTitle: string; userName: string },
): KnowledgeEntry {
  const now = new Date()
  const entry: KnowledgeEntry = {
    date: toLocalDate(now),
    time: toLocalTime(now),
    sessionId: '',
    sessionTitle: input.sessionTitle,
    userName: input.userName,
    content: input.content.trim(),
    ts: now.getTime(),
    manual: true,
  }
  appendEntry(project, entry)
  return entry
}

export async function refreshSummary(project: Project, recentLimit = 25): Promise<{ costUsd: number }> {
  const view = await readKnowledge(project)
  const recent = view.days.flatMap((day) => day.entries).slice(0, recentLimit)
  if (!recent.length) return { costUsd: 0 }

  const body = [
    `Proyecto: ${project.name}`,
    project.description ? `Descripción del dueño: ${project.description}` : '',
    '',
    '--- RESUMEN ANTERIOR ---',
    project.summary ?? '(no había)',
    '',
    '--- ENTRADAS RECIENTES (de más nueva a más vieja) ---',
    ...recent.map((e) => `[${e.date} ${e.time}] ${e.content}`),
  ]
    .filter(Boolean)
    .join('\n')

  const { text, costUsd } = await runPrompt(project, `${SUMMARY_PROMPT}\n${body}`)
  if (text) {
    project.summary = text
    project.summaryUpdatedAt = Date.now()
    writeSummaryMarkdown(project, text)
  }
  return { costUsd }
}

/** Fecha local, no UTC: el historial se agrupa por el día del usuario. */
function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function toLocalTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const pad = (n: number) => String(n).padStart(2, '0')
