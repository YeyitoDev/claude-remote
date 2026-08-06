import { HttpError } from './auth.js'
import { appendUsage, readUsage } from './store.js'
import type { UsageRecord, UsageSummary, User } from './types.js'

/** Inicio del mes natural en curso, que es la ventana de los límites. */
function monthStart(now = Date.now()): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/**
 * Contabilidad de gasto. El detalle vive en `usage.jsonl` (append-only, una
 * línea por turno) y los agregados se mantienen en memoria para poder decidir
 * un límite sin releer el archivo en cada request.
 */
export class Usage {
  private records: UsageRecord[] = []
  private loaded = false

  async load() {
    this.records = await readUsage()
    this.loaded = true
  }

  record(rec: UsageRecord) {
    this.records.push(rec)
    appendUsage(rec)
  }

  summaryFor(userId: string, now = Date.now()): UsageSummary {
    const since = monthStart(now)
    let monthUsd = 0
    let monthTurns = 0
    let totalUsd = 0
    let totalTurns = 0
    for (const rec of this.records) {
      if (rec.userId !== userId) continue
      totalUsd += rec.costUsd
      totalTurns += rec.numTurns
      if (rec.ts >= since) {
        monthUsd += rec.costUsd
        monthTurns += rec.numTurns
      }
    }
    return { monthUsd, monthTurns, totalUsd, totalTurns }
  }

  /**
   * Corta antes de arrancar trabajo nuevo, no en mitad de un turno: un turno
   * ya empezado se deja terminar y se cobra, y es el siguiente el que se
   * bloquea. Cortar a media ejecución dejaría archivos a medio escribir.
   */
  assertWithinBudget(user: User) {
    const limit = user.limits.monthlyUsd
    if (limit === null) return
    const { monthUsd } = this.summaryFor(user.id)
    if (monthUsd >= limit) {
      throw new HttpError(
        402,
        `Límite mensual alcanzado: $${monthUsd.toFixed(2)} de $${limit.toFixed(2)}. Habla con el administrador.`,
      )
    }
  }

  /** Registros para el panel de admin, del más reciente al más antiguo. */
  query(filter: { userId?: string; projectId?: string; since?: number; limit?: number }): UsageRecord[] {
    const limit = filter.limit ?? 500
    return this.records
      .filter(
        (r) =>
          (!filter.userId || r.userId === filter.userId) &&
          (!filter.projectId || r.projectId === filter.projectId) &&
          (!filter.since || r.ts >= filter.since),
      )
      .slice(-limit)
      .reverse()
  }

  /**
   * Serie diaria continua para la gráfica: incluye los días sin gasto, porque
   * si no una sola jornada de uso se dibuja como una barra que ocupa todo.
   */
  dailyTotals(days = 30, now = Date.now(), userId?: string): { date: string; usd: number; turns: number }[] {
    const buckets = new Map<string, { usd: number; turns: number }>()
    for (let i = days - 1; i >= 0; i--) {
      buckets.set(localDate(now - i * 86_400_000), { usd: 0, turns: 0 })
    }
    for (const rec of this.records) {
      if (userId && rec.userId !== userId) continue
      const bucket = buckets.get(localDate(rec.ts))
      if (!bucket) continue
      bucket.usd += rec.costUsd
      bucket.turns += rec.numTurns
    }
    return [...buckets.entries()].map(([date, v]) => ({ date, ...v }))
  }

  get isLoaded() {
    return this.loaded
  }
}

/** Día local, no UTC: la gráfica debe cuadrar con el calendario del admin. */
function localDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
