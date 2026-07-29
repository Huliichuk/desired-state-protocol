import type { SecretReference } from '@dsp/protocol'

/**
 * A resolved secret. The plaintext is only reachable through `reveal()`, and
 * every accidental serialization path (`JSON.stringify`, string interpolation,
 * `console.log`) yields a redaction marker instead of the value.
 */
export class SecretValue {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  reveal(): string {
    return this.#value
  }

  get length(): number {
    return this.#value.length
  }

  toString(): string {
    return '[REDACTED]'
  }

  toJSON(): string {
    return '[REDACTED]'
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'SecretValue([REDACTED])'
  }
}

export interface ResolvedSecret {
  reference: SecretReference
  value: SecretValue
  version: string
  updatedAt: string
}

export interface SecretStore {
  getSecret(reference: SecretReference): Promise<ResolvedSecret>
  setSecret(reference: SecretReference, value: string): Promise<void>
  deleteSecret(reference: SecretReference): Promise<void>
  listSecretNames(): Promise<string[]>
}

export function secretKey(reference: SecretReference): string {
  return reference.key === undefined ? reference.name : `${reference.name}/${reference.key}`
}
