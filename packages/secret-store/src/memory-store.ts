import { DSPError, type SecretReference } from '@dsp/protocol'
import { SecretValue, secretKey, type ResolvedSecret, type SecretStore } from './types.js'

/**
 * In-memory secret store for tests and ephemeral runtimes. Values are never
 * written to disk and disappear with the process.
 */
export class MemorySecretStore implements SecretStore {
  readonly #secrets = new Map<string, { value: string; version: string; updatedAt: string }>()

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.#secrets.set(key, { value, version: '1', updatedAt: new Date(0).toISOString() })
    }
  }

  async getSecret(reference: SecretReference): Promise<ResolvedSecret> {
    const key = secretKey(reference)
    const entry = this.#secrets.get(key)
    if (entry === undefined) {
      throw new DSPError('SECRET_NOT_FOUND', `Secret "${key}" is not configured`, {
        details: { secret: key },
      })
    }
    return {
      reference,
      value: new SecretValue(entry.value),
      version: entry.version,
      updatedAt: entry.updatedAt,
    }
  }

  async setSecret(reference: SecretReference, value: string): Promise<void> {
    const key = secretKey(reference)
    const previous = this.#secrets.get(key)
    this.#secrets.set(key, {
      value,
      version: previous === undefined ? '1' : String(Number(previous.version) + 1),
      updatedAt: new Date().toISOString(),
    })
  }

  async deleteSecret(reference: SecretReference): Promise<void> {
    this.#secrets.delete(secretKey(reference))
  }

  async listSecretNames(): Promise<string[]> {
    return [...this.#secrets.keys()].sort()
  }
}
