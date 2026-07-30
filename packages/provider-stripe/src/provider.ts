import type {
  ChangeExecutionResult,
  CurrentState,
  DesiredStateDocument,
  KindDefinition,
  PlanChange,
  ResourceProjection,
  ResourceTypeDefinition,
  SecretReference,
  ValidationIssue,
  ValidationResult,
} from '@dsp/protocol'
import { documentNamespace, hashCanonical } from '@dsp/protocol'
import {
  assertNotAborted,
  providerError,
  unsupportedOperation,
  type DSPProvider,
  type ProviderContext,
  type ProviderExecutionContext,
} from '@dsp/provider-sdk'
import { stripeCatalogKind, stripeResourceTypes } from './definitions.js'
import { priceKey, productKey, projectSpec, projectState } from './projection.js'
import { FetchStripeTransport, type StripeTransport } from './transport.js'
import {
  OWNER_METADATA_KEY,
  STRIPE_PROVIDER_NAME,
  STRIPE_RESOURCE_TYPES,
  type StripeCatalogSpec,
  type StripeCatalogState,
  type StripeInterval,
  type StripePriceState,
  type StripeProductState,
} from './types.js'

export interface StripeProviderOptions {
  transport?: StripeTransport
  /** Page size for list calls. Stripe caps this at 100. */
  pageSize?: number
}

interface StripeList<T> {
  data: T[]
  has_more: boolean
}

interface RawProduct {
  id: string
  name: string
  description: string | null
  active: boolean
  metadata: Record<string, string>
}

interface RawPrice {
  id: string
  lookup_key: string | null
  product: string
  currency: string
  unit_amount: number | null
  recurring: { interval: StripeInterval } | null
  active: boolean
  nickname: string | null
  metadata: Record<string, string>
}

type Document = DesiredStateDocument<StripeCatalogSpec>

export class StripeProvider implements DSPProvider<StripeCatalogSpec, StripeCatalogState> {
  readonly name = STRIPE_PROVIDER_NAME
  readonly version = '0.2.0'
  readonly kinds: KindDefinition[] = [stripeCatalogKind]
  readonly resourceTypes: ResourceTypeDefinition[] = stripeResourceTypes

  readonly #transport: StripeTransport
  readonly #pageSize: number

  constructor(options: StripeProviderOptions = {}) {
    this.#transport = options.transport ?? new FetchStripeTransport()
    this.#pageSize = options.pageSize ?? 100
  }

  requiredSecrets(desired: Document): SecretReference[] {
    const reference = desired.spec.credentials?.secretRef
    return reference === undefined ? [] : [reference]
  }

  /**
   * Semantic checks the schema cannot express, and one that only Stripe's own model
   * can explain. No API calls: `validate` must stay free of side effects, and the
   * checks here are all internal to the document.
   */
  async validate(context: ProviderContext, desired: Document): Promise<ValidationResult> {
    assertNotAborted(context)

    const errors: ValidationIssue[] = []
    const warnings: ValidationIssue[] = []
    const spec = desired.spec

    const productIds = new Set<string>()
    ;(spec.products ?? []).forEach((product, index) => {
      if (productIds.has(product.id)) {
        errors.push({
          code: 'VALIDATION_FAILED',
          path: `spec.products[${index}].id`,
          message: `Duplicate product id "${product.id}"`,
        })
      }
      productIds.add(product.id)
    })

    const lookupKeys = new Set<string>()
    ;(spec.prices ?? []).forEach((price, index) => {
      const path = `spec.prices[${index}]`

      if (lookupKeys.has(price.lookupKey)) {
        errors.push({
          code: 'VALIDATION_FAILED',
          path: `${path}.lookupKey`,
          message: `Duplicate price lookupKey "${price.lookupKey}"`,
        })
      }
      lookupKeys.add(price.lookupKey)

      if (!productIds.has(price.product)) {
        errors.push({
          code: 'UNRESOLVED_REFERENCE',
          path: `${path}.product`,
          message: `Price references product "${price.product}", which is not declared in spec.products`,
        })
      }

      // Stripe keeps a price as an immutable record of past transactions. Changing
      // an amount means creating a new price and archiving the old one, so a
      // document that reuses a lookup key for a new amount is describing something
      // Stripe will not do. The runtime would block it as a replace; saying it here
      // explains the actual workflow instead.
      if (price.unitAmountCents === 0 && price.recurring !== undefined) {
        warnings.push({
          code: 'ZERO_AMOUNT_RECURRING',
          path: `${path}.unitAmountCents`,
          message: 'A recurring price of zero is valid in Stripe but rarely intended',
        })
      }
    })

    if (spec.credentials === undefined) {
      warnings.push({
        code: 'MISSING_CREDENTIALS',
        path: 'spec.credentials',
        message:
          'No secretRef declared, so the runtime has no Stripe key to resolve and apply will fail',
      })
    }

    return { valid: errors.length === 0, errors, warnings }
  }

  /**
   * Reads the products and prices this document owns.
   *
   * Ownership is the whole difficulty. A Stripe account is shared: it holds
   * resources created by the dashboard, by other tools, and by other DSP documents.
   * Reporting all of them would make every unrelated product look like something
   * this document wants deleted. So `inspect` reports only what carries this
   * document's ownership marker.
   */
  async inspect(
    context: ProviderContext,
    desired: Document,
  ): Promise<CurrentState<StripeCatalogState>> {
    assertNotAborted(context)

    const apiKey = await this.#apiKey(context, desired)
    const owner = ownerTag(desired)

    const products = (await this.#listAll<RawProduct>('/v1/products', apiKey, context))
      .filter((product) => product.metadata[OWNER_METADATA_KEY] === owner)
      .map(toProductState)

    const prices = (await this.#listAll<RawPrice>('/v1/prices', apiKey, context))
      .filter((price) => price.metadata[OWNER_METADATA_KEY] === owner)
      .map(toPriceState)

    const state: StripeCatalogState = {
      products: products.sort((a, b) => compare(a.id, b.id)),
      prices: prices.sort((a, b) => compare(a.lookupKey ?? a.id, b.lookupKey ?? b.id)),
    }

    return {
      resourceType: stripeCatalogKind.kind,
      resourceId: `${documentNamespace(desired)}/${desired.metadata.name}`,
      observedAt: context.now().toISOString(),
      revision: revisionOf(state),
      state,
    }
  }

  async normalizeDesired(desired: Document): Promise<ResourceProjection> {
    return projectSpec(desired.spec)
  }

  async normalizeCurrent(current: CurrentState<StripeCatalogState>): Promise<ResourceProjection> {
    return current.state === null ? { resources: [] } : projectState(current.state)
  }

  /**
   * Annotates what the generic diff cannot know: that archiving a price is the only
   * way to retire it, and that deactivating a product hides everything priced under
   * it from customers.
   */
  async plan(_context: ProviderContext, input: { changes: PlanChange[] }): Promise<PlanChange[]> {
    return input.changes.map((change) => {
      const becameInactive = change.fields.some(
        (field) => field.path === 'active' && field.before === true && field.after === false,
      )
      if (!becameInactive) return change

      const noun = change.resourceType === STRIPE_RESOURCE_TYPES.price ? 'price' : 'product'
      return {
        ...change,
        destructive: true,
        reason: `${change.reason}; archiving a ${noun} withdraws it from new purchases`,
      }
    })
  }

  async applyChange(
    context: ProviderExecutionContext,
    change: PlanChange,
  ): Promise<ChangeExecutionResult> {
    assertNotAborted(context)

    if (change.action === 'blocked' || change.action === 'noop') {
      throw unsupportedOperation(`The runtime must not execute a "${change.action}" change`)
    }
    if (change.action === 'delete' || change.action === 'replace') {
      // Both resource types declare `delete: false`, so the runtime blocks these
      // before they reach here. Refusing again keeps the guarantee local: a price is
      // a financial record and this provider will not destroy one.
      throw unsupportedOperation(
        `Stripe ${change.resourceType} cannot be ${change.action}d; archive it with active: false instead`,
      )
    }

    const desired = context.desired as Document
    const apiKey = await this.#apiKey(context, desired)
    const after = (change.after ?? {}) as Record<string, unknown>

    // Derived from the operation and the change, so a retried attempt reuses the
    // key and Stripe deduplicates the write rather than creating a second object.
    const idempotencyKey = `${context.idempotencyKey}:${change.id}`

    if (change.resourceType === STRIPE_RESOURCE_TYPES.product) {
      return await this.#applyProduct(context, change, after, apiKey, idempotencyKey, desired)
    }
    if (change.resourceType === STRIPE_RESOURCE_TYPES.price) {
      return await this.#applyPrice(context, change, after, apiKey, idempotencyKey, desired)
    }

    throw unsupportedOperation(`Unknown resource type "${change.resourceType}"`)
  }

  async #applyProduct(
    context: ProviderExecutionContext,
    change: PlanChange,
    after: Record<string, unknown>,
    apiKey: string,
    idempotencyKey: string,
    desired: Document,
  ): Promise<ChangeExecutionResult> {
    const id = String(after['id'])
    const metadata = { ...asMetadata(after['metadata']), [OWNER_METADATA_KEY]: ownerTag(desired) }

    if (change.action === 'create') {
      const created = await this.#transport.request<RawProduct>({
        method: 'POST',
        path: '/v1/products',
        apiKey,
        idempotencyKey,
        signal: context.signal,
        params: {
          id,
          name: after['name'],
          description: after['description'] ?? undefined,
          active: after['active'],
          metadata,
        },
      })
      return {
        externalId: created.id,
        providerRequestId: idempotencyKey,
        observed: toProductState(created) as unknown as Record<string, unknown>,
      }
    }

    // Update. `id` is immutable, so only the mutable fields are sent.
    const updated = await this.#transport.request<RawProduct>({
      method: 'POST',
      path: `/v1/products/${encodeURIComponent(id)}`,
      apiKey,
      idempotencyKey,
      signal: context.signal,
      params: {
        name: after['name'],
        description: after['description'] ?? null,
        active: after['active'],
        metadata,
      },
    })
    return {
      externalId: updated.id,
      providerRequestId: idempotencyKey,
      observed: toProductState(updated) as unknown as Record<string, unknown>,
    }
  }

  async #applyPrice(
    context: ProviderExecutionContext,
    change: PlanChange,
    after: Record<string, unknown>,
    apiKey: string,
    idempotencyKey: string,
    desired: Document,
  ): Promise<ChangeExecutionResult> {
    const metadata = { ...asMetadata(after['metadata']), [OWNER_METADATA_KEY]: ownerTag(desired) }

    if (change.action === 'create') {
      const created = await this.#transport.request<RawPrice>({
        method: 'POST',
        path: '/v1/prices',
        apiKey,
        idempotencyKey,
        signal: context.signal,
        params: {
          lookup_key: after['lookupKey'],
          product: after['product'],
          currency: after['currency'],
          unit_amount: after['unitAmountCents'],
          recurring: after['recurring'] ?? undefined,
          active: after['active'],
          nickname: after['nickname'] ?? undefined,
          metadata,
        },
      })
      return {
        externalId: created.id,
        providerRequestId: idempotencyKey,
        observed: toPriceState(created) as unknown as Record<string, unknown>,
      }
    }

    // Stripe accepts only `active`, `nickname` and `metadata` on an existing price.
    // Anything else is immutable and should have become a blocked replace, so a
    // change that reaches here touching one is a runtime bug, not a Stripe error.
    const mutable = new Set(['active', 'nickname', 'metadata'])
    const forbidden = change.fields.map((field) => field.path).filter((path) => !mutable.has(path))
    if (forbidden.length > 0) {
      throw providerError(
        `A Stripe price cannot change ${forbidden.join(', ')} after creation; a new price is required`,
        { retryable: false, details: { fields: forbidden } },
      )
    }

    const externalId = await this.#priceIdForLookupKey(
      context,
      apiKey,
      String(after['lookupKey']),
      ownerTag(desired),
    )

    const updated = await this.#transport.request<RawPrice>({
      method: 'POST',
      path: `/v1/prices/${encodeURIComponent(externalId)}`,
      apiKey,
      idempotencyKey,
      signal: context.signal,
      params: {
        active: after['active'],
        nickname: after['nickname'] ?? undefined,
        metadata,
      },
    })
    return {
      externalId: updated.id,
      providerRequestId: idempotencyKey,
      observed: toPriceState(updated) as unknown as Record<string, unknown>,
    }
  }

  /**
   * A price has no client-settable id, so updating one means finding the Stripe id
   * behind its lookup key. Listing and filtering rather than using the search API:
   * Stripe's search index is eventually consistent, and a price created moments ago
   * may not be in it yet.
   */
  async #priceIdForLookupKey(
    context: ProviderContext,
    apiKey: string,
    lookupKey: string,
    owner: string,
  ): Promise<string> {
    const prices = await this.#listAll<RawPrice>('/v1/prices', apiKey, context, {
      lookup_keys: [lookupKey],
    })
    const owned = prices.find(
      (price) => price.lookup_key === lookupKey && price.metadata[OWNER_METADATA_KEY] === owner,
    )
    if (owned === undefined) {
      throw providerError(`No Stripe price with lookup key "${lookupKey}" is managed here`, {
        retryable: false,
      })
    }
    return owned.id
  }

  async #listAll<T>(
    path: string,
    apiKey: string,
    context: ProviderContext,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    const collected: T[] = []
    let startingAfter: string | undefined

    // Bounded so a large account cannot make one inspection run forever.
    for (let page = 0; page < 20; page += 1) {
      assertNotAborted(context)
      const response = await this.#transport.request<StripeList<T>>({
        method: 'GET',
        path,
        apiKey,
        signal: context.signal,
        params: { ...params, limit: this.#pageSize, starting_after: startingAfter },
      })

      collected.push(...response.data)
      if (!response.has_more || response.data.length === 0) return collected

      const last = response.data[response.data.length - 1] as { id?: string }
      if (last?.id === undefined) return collected
      startingAfter = last.id
    }

    throw providerError('Stripe returned more pages than this provider will read', {
      retryable: false,
    })
  }

  async #apiKey(context: ProviderContext, desired: Document): Promise<string> {
    const reference = desired.spec.credentials?.secretRef
    if (reference === undefined) {
      throw providerError('No Stripe credential is declared in spec.credentials', {
        retryable: false,
      })
    }
    const resolved = await context.secrets.resolve(reference)
    return resolved.value.reveal()
  }
}

/**
 * Identifies the document that owns a resource. Namespace and name, so two
 * documents in the same account never see each other's resources as drift.
 */
function ownerTag(desired: Document): string {
  return `${documentNamespace(desired)}/${desired.metadata.name}`
}

function asMetadata(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]),
  )
}

function toProductState(product: RawProduct): StripeProductState {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    active: product.active,
    metadata: product.metadata ?? {},
  }
}

function toPriceState(price: RawPrice): StripePriceState {
  return {
    id: price.id,
    lookupKey: price.lookup_key,
    product: price.product,
    currency: price.currency,
    unitAmountCents: price.unit_amount,
    recurring: price.recurring,
    active: price.active,
    nickname: price.nickname,
    metadata: price.metadata ?? {},
  }
}

/**
 * Derived from the observed resources rather than a timestamp: a revision that
 * changes when nothing did would make every plan look drifted.
 */
function revisionOf(state: StripeCatalogState): string {
  if (state.products.length === 0 && state.prices.length === 0) return 'empty'
  return hashCanonical(state)
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export { productKey, priceKey }
