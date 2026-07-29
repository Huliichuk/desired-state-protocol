import { DSPError, type SecretReference } from '@dsp/protocol'
import { secretKey, type ResolvedSecret, type SecretStore } from './types.js'

export interface SecretResolver {
  /** Resolves a secret the caller was explicitly granted access to. */
  resolve(reference: SecretReference): Promise<ResolvedSecret>
  /** References this resolver is allowed to serve. */
  allowedReferences(): SecretReference[]
  /**
   * Plaintext values revealed through this resolver, so that the runtime can
   * scrub them from logs, plans and audit events.
   */
  revealedValues(): string[]
}

/**
 * Grants a provider access to a fixed allow-list of secrets and nothing else.
 *
 * Providers never receive the SecretStore itself: a compromised or buggy
 * provider must not be able to enumerate or read credentials it was not given.
 */
export class ScopedSecretResolver implements SecretResolver {
  readonly #store: SecretStore
  readonly #allowed: Map<string, SecretReference>
  readonly #revealed = new Set<string>()
  readonly #onResolve: ((reference: SecretReference) => void) | undefined

  constructor(
    store: SecretStore,
    allowed: readonly SecretReference[],
    onResolve?: (reference: SecretReference) => void,
  ) {
    this.#store = store
    this.#allowed = new Map(allowed.map((reference) => [secretKey(reference), reference]))
    this.#onResolve = onResolve
  }

  async resolve(reference: SecretReference): Promise<ResolvedSecret> {
    const key = secretKey(reference)
    if (!this.#allowed.has(key)) {
      throw new DSPError(
        'SECRET_ACCESS_DENIED',
        `Secret "${key}" was not declared by the Desired State document`,
        { details: { secret: key } },
      )
    }
    const resolved = await this.#store.getSecret(reference)
    this.#revealed.add(resolved.value.reveal())
    this.#onResolve?.(reference)
    return resolved
  }

  allowedReferences(): SecretReference[] {
    return [...this.#allowed.values()]
  }

  revealedValues(): string[] {
    return [...this.#revealed]
  }
}

/**
 * A resolver that denies everything. Used for `validate` and `plan` on
 * providers that declare no credential needs, and as a safe default.
 */
export class DenyAllSecretResolver implements SecretResolver {
  async resolve(reference: SecretReference): Promise<ResolvedSecret> {
    throw new DSPError(
      'SECRET_ACCESS_DENIED',
      `Secret access is not permitted in this context (requested "${secretKey(reference)}")`,
    )
  }

  allowedReferences(): SecretReference[] {
    return []
  }

  revealedValues(): string[] {
    return []
  }
}
