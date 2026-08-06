/**
 * Cola asíncrona que alimenta el modo streaming input del Agent SDK.
 *
 * Esta es la pieza que mantiene la sesión viva: mientras el iterador no se
 * cierre, `query()` se queda esperando el siguiente mensaje en vez de terminar,
 * así que el proceso del CLI (y todo su contexto) sobrevive entre turnos.
 */
export class AsyncQueue<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as unknown as T, done: true })
    }
  }

  get isClosed() {
    return this.closed
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift() as T
        continue
      }
      if (this.closed) return
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
      if (next.done) return
      yield next.value
    }
  }
}
