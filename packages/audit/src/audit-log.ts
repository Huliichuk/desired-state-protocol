import { redactSensitiveData, type AuditChainVerification, type AuditEvent } from '@dsp/protocol'
import { createAuditEvent, verifyChain, type AuditEventInput } from './chain.js'
import type { AuditQuery, AuditStore } from './store.js'

export interface AuditLogOptions {
  store: AuditStore
  now?: () => Date
  /** Literal secret values that must never reach the log. */
  redactValues?: () => string[]
}

/**
 * Serializes appends so that concurrent writers cannot interleave and break the
 * hash chain.
 */
export class AuditLog {
  readonly #store: AuditStore
  readonly #now: () => Date
  readonly #redactValues: () => string[]
  #tail: Promise<AuditEvent | null>

  constructor(options: AuditLogOptions) {
    this.#store = options.store
    this.#now = options.now ?? (() => new Date())
    this.#redactValues = options.redactValues ?? (() => [])
    this.#tail = options.store.last()
  }

  async record(input: AuditEventInput): Promise<AuditEvent> {
    const next = this.#tail.then(async (previous) => {
      const event = createAuditEvent({
        input: {
          ...input,
          metadata: redactSensitiveData(input.metadata ?? {}, {
            values: this.#redactValues(),
          }) as Record<string, unknown>,
        },
        previous,
        timestamp: this.#now().toISOString(),
      })
      await this.#store.append(event)
      return event
    })

    // Keep the chain usable even if one append fails: fall back to the store.
    this.#tail = next.catch(() => this.#store.last())
    return next
  }

  async list(query?: AuditQuery): Promise<AuditEvent[]> {
    return this.#store.list(query)
  }

  async get(id: string): Promise<AuditEvent | null> {
    return this.#store.get(id)
  }

  async verify(): Promise<AuditChainVerification> {
    return verifyChain(await this.#store.list())
  }
}
