import {
  DSPError,
  createSchemaValidator,
  desiredStateSchema,
  type DesiredStateDocument,
  type KindDefinition,
  type ResourceTypeDefinition,
  type SchemaValidator,
} from '@dsp/protocol'
import type { DSPProvider } from '@dsp/provider-sdk'

/**
 * Maps document kinds and resource types to the providers that own them.
 *
 * DSP servers publish resource types, not tools: the registry is the single
 * place that answers "what can this runtime make true, and who does it".
 */
export class ResourceRegistry {
  readonly #providers: DSPProvider[]
  readonly #providerByKind = new Map<string, DSPProvider>()
  readonly #kinds = new Map<string, KindDefinition>()
  readonly #resourceTypes = new Map<string, ResourceTypeDefinition>()
  readonly #specValidators = new Map<string, SchemaValidator>()
  readonly #envelopeValidator = createSchemaValidator(desiredStateSchema)

  constructor(providers: readonly DSPProvider[]) {
    this.#providers = [...providers]

    for (const provider of this.#providers) {
      for (const kind of provider.kinds) {
        if (this.#kinds.has(kind.kind)) {
          throw new DSPError(
            'INTERNAL_ERROR',
            `Kind "${kind.kind}" is registered by more than one provider`,
            { details: { kind: kind.kind } },
          )
        }
        this.#kinds.set(kind.kind, kind)
        this.#providerByKind.set(kind.kind, provider)
        this.#specValidators.set(
          kind.kind,
          createSchemaValidator(kind.specSchema, { basePath: 'spec' }),
        )
      }

      for (const resourceType of provider.resourceTypes) {
        if (this.#resourceTypes.has(resourceType.name)) {
          throw new DSPError(
            'INTERNAL_ERROR',
            `Resource type "${resourceType.name}" is registered by more than one provider`,
            { details: { resourceType: resourceType.name } },
          )
        }
        this.#resourceTypes.set(resourceType.name, resourceType)
      }
    }
  }

  providers(): DSPProvider[] {
    return [...this.#providers]
  }

  kinds(): KindDefinition[] {
    return [...this.#kinds.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1))
  }

  kind(name: string): KindDefinition {
    const kind = this.#kinds.get(name)
    if (kind === undefined) {
      throw new DSPError('UNKNOWN_KIND', `Kind "${name}" is not served by this runtime`, {
        details: { kind: name, available: [...this.#kinds.keys()] },
      })
    }
    return kind
  }

  resourceTypes(): ResourceTypeDefinition[] {
    return [...this.#resourceTypes.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
  }

  resourceType(name: string): ResourceTypeDefinition {
    const definition = this.#resourceTypes.get(name)
    if (definition === undefined) {
      throw new DSPError(
        'UNKNOWN_RESOURCE_TYPE',
        `Resource type "${name}" is not served by this runtime`,
        { details: { resourceType: name } },
      )
    }
    return definition
  }

  resourceTypeMap(): ReadonlyMap<string, ResourceTypeDefinition> {
    return this.#resourceTypes
  }

  providerForKind(kind: string): DSPProvider {
    const provider = this.#providerByKind.get(kind)
    if (provider === undefined) {
      throw new DSPError('PROVIDER_NOT_FOUND', `No provider serves kind "${kind}"`, {
        details: { kind },
      })
    }
    return provider
  }

  envelopeValidator(): SchemaValidator {
    return this.#envelopeValidator
  }

  specValidator(kind: string): SchemaValidator {
    const validator = this.#specValidators.get(kind)
    if (validator === undefined) {
      throw new DSPError('UNKNOWN_KIND', `Kind "${kind}" has no registered spec schema`, {
        details: { kind },
      })
    }
    return validator
  }

  /**
   * Narrows an untrusted payload to a Desired State document. Only the envelope
   * is checked here; the spec is validated against the kind's schema by the
   * runtime, which can then report both sets of errors together.
   */
  asDocument(raw: unknown): DesiredStateDocument {
    const result = this.#envelopeValidator.validate(raw)
    if (!result.valid) {
      throw new DSPError('SCHEMA_VALIDATION_FAILED', 'Desired State document is not valid', {
        details: { errors: result.errors },
      })
    }
    return raw as DesiredStateDocument
  }
}
