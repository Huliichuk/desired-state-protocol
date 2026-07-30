import type { ResourceInstance, ResourceProjection } from '@dsp/protocol'
import {
  OWNER_METADATA_KEY,
  STRIPE_RESOURCE_TYPES,
  type StripeCatalogSpec,
  type StripeCatalogState,
} from './types.js'

export const productKey = (id: string): string => `${STRIPE_RESOURCE_TYPES.product}/${id}`
export const priceKey = (lookupKey: string): string => `${STRIPE_RESOURCE_TYPES.price}/${lookupKey}`

/**
 * Drops keys that hold no value, so an omitted optional field and an explicitly
 * absent one project identically. Without this, adding `description` to a document
 * and leaving it empty would read as a change.
 */
function compact(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined))
}

/**
 * The ownership marker is provider bookkeeping, not a managed attribute. It is
 * stripped from both sides of the projection: leaving it in the observed state but
 * not the desired one would make every resource look permanently changed.
 */
function visibleMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  const entries = Object.entries(metadata ?? {}).filter(([key]) => key !== OWNER_METADATA_KEY)
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function projectSpec(spec: StripeCatalogSpec): ResourceProjection {
  const resources: ResourceInstance[] = []

  for (const product of spec.products ?? []) {
    resources.push({
      resourceType: STRIPE_RESOURCE_TYPES.product,
      key: productKey(product.id),
      attributes: compact({
        id: product.id,
        name: product.name,
        description: product.description ?? null,
        // Stripe defaults a new product to active, so the projection has to say so
        // on both sides or every product would look changed after creation.
        active: product.active ?? true,
        metadata: visibleMetadata(product.metadata),
      }),
    })
  }

  for (const price of spec.prices ?? []) {
    resources.push({
      resourceType: STRIPE_RESOURCE_TYPES.price,
      key: priceKey(price.lookupKey),
      // A price cannot exist before its product. Expressing it here is what lets
      // the runtime order the plan without the provider sequencing anything.
      dependsOn: [productKey(price.product)],
      attributes: compact({
        lookupKey: price.lookupKey,
        product: price.product,
        currency: price.currency,
        unitAmountCents: price.unitAmountCents,
        recurring: price.recurring ?? null,
        active: price.active ?? true,
        nickname: price.nickname ?? null,
        metadata: visibleMetadata(price.metadata),
      }),
    })
  }

  return { resources }
}

export function projectState(state: StripeCatalogState): ResourceProjection {
  const resources: ResourceInstance[] = []

  for (const product of state.products) {
    resources.push({
      resourceType: STRIPE_RESOURCE_TYPES.product,
      key: productKey(product.id),
      // Stripe's id is both the identity and the external id here, which is the
      // convenient case. Prices are not so lucky.
      externalId: product.id,
      attributes: {
        id: product.id,
        name: product.name,
        description: product.description,
        active: product.active,
        metadata: visibleMetadata(product.metadata),
      },
    })
  }

  for (const price of state.prices) {
    // A price with no lookup key cannot be addressed declaratively, so it is not
    // something this document can be said to manage.
    if (price.lookupKey === null) continue

    resources.push({
      resourceType: STRIPE_RESOURCE_TYPES.price,
      key: priceKey(price.lookupKey),
      externalId: price.id,
      dependsOn: [productKey(price.product)],
      attributes: {
        lookupKey: price.lookupKey,
        product: price.product,
        currency: price.currency,
        unitAmountCents: price.unitAmountCents ?? 0,
        recurring: price.recurring,
        active: price.active,
        nickname: price.nickname,
        metadata: visibleMetadata(price.metadata),
      },
    })
  }

  return { resources }
}
