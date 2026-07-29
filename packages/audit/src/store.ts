import type { AuditEvent } from '@dsp/protocol'

export interface AuditQuery {
  limit?: number
  /** Return events with a sequence strictly greater than this. */
  afterSequence?: number
  planId?: string
  operationId?: string
  action?: string
}

export interface AuditStore {
  append(event: AuditEvent): Promise<void>
  last(): Promise<AuditEvent | null>
  list(query?: AuditQuery): Promise<AuditEvent[]>
  get(id: string): Promise<AuditEvent | null>
  count(): Promise<number>
}

export class MemoryAuditStore implements AuditStore {
  readonly #events: AuditEvent[] = []

  async append(event: AuditEvent): Promise<void> {
    this.#events.push(event)
  }

  async last(): Promise<AuditEvent | null> {
    return this.#events.at(-1) ?? null
  }

  async list(query: AuditQuery = {}): Promise<AuditEvent[]> {
    let events = this.#events
    if (query.afterSequence !== undefined) {
      const after = query.afterSequence
      events = events.filter((event) => event.sequence > after)
    }
    if (query.planId !== undefined) events = events.filter((event) => event.planId === query.planId)
    if (query.operationId !== undefined) {
      events = events.filter((event) => event.operationId === query.operationId)
    }
    if (query.action !== undefined) events = events.filter((event) => event.action === query.action)
    return query.limit === undefined ? [...events] : events.slice(0, query.limit)
  }

  async get(id: string): Promise<AuditEvent | null> {
    return this.#events.find((event) => event.id === id) ?? null
  }

  async count(): Promise<number> {
    return this.#events.length
  }
}
