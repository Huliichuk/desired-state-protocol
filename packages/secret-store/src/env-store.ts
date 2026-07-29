import { DSPError, type SecretReference } from '@dsp/protocol'
import { SecretValue, secretKey, type ResolvedSecret, type SecretStore } from './types.js'

const DEFAULT_PREFIX = 'DSP_SECRET_'

/**
 * Reads secrets from environment variables. `stripe-test` maps to
 * `DSP_SECRET_STRIPE_TEST`, and `stripe-test/apiKey` to
 * `DSP_SECRET_STRIPE_TEST_API_KEY`.
 *
 * Read-only by design: mutating the process environment at runtime would make
 * the runtime's secret state untraceable.
 */
export class EnvSecretStore implements SecretStore {
  readonly #prefix: string
  readonly #env: NodeJS.ProcessEnv

  constructor(options: { prefix?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.#prefix = options.prefix ?? DEFAULT_PREFIX
    this.#env = options.env ?? process.env
  }

  async getSecret(reference: SecretReference): Promise<ResolvedSecret> {
    const variable = this.#variableName(reference)
    const value = this.#env[variable]
    if (value === undefined || value.length === 0) {
      throw new DSPError('SECRET_NOT_FOUND', `Secret "${secretKey(reference)}" is not configured`, {
        details: { secret: secretKey(reference), expectedEnvVar: variable },
      })
    }
    return {
      reference,
      value: new SecretValue(value),
      version: 'env',
      updatedAt: new Date(0).toISOString(),
    }
  }

  // The parameters are unused but declared: dropping them left the concrete class
  // with a narrower signature than the SecretStore interface, so a caller holding
  // an EnvSecretStore could not call it the way the interface documents.
  async setSecret(_reference: SecretReference, _value: string): Promise<void> {
    throw new DSPError('UNSUPPORTED_OPERATION', 'The environment secret store is read-only')
  }

  async deleteSecret(_reference: SecretReference): Promise<void> {
    throw new DSPError('UNSUPPORTED_OPERATION', 'The environment secret store is read-only')
  }

  async listSecretNames(): Promise<string[]> {
    return Object.keys(this.#env)
      .filter((name) => name.startsWith(this.#prefix))
      .map((name) => name.slice(this.#prefix.length).toLowerCase().replaceAll('_', '-'))
      .sort()
  }

  #variableName(reference: SecretReference): string {
    return `${this.#prefix}${toEnvSegment(secretKey(reference))}`
  }
}

export function toEnvSegment(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase()
}
