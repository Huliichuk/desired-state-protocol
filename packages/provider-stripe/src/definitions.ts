import type { JsonSchema, KindDefinition, ResourceTypeDefinition } from '@dsp/protocol'
import {
  STRIPE_INTERVALS,
  STRIPE_KIND,
  STRIPE_PROVIDER_NAME,
  STRIPE_RESOURCE_TYPES,
} from './types.js'

const metadataSchema: JsonSchema = {
  type: 'object',
  additionalProperties: { type: 'string', maxLength: 500 },
  propertyNames: { maxLength: 40 },
}

const productSpecSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name'],
  properties: {
    // Stripe accepts a client-supplied product id, which is the only reason a
    // stable DSP key exists before the resource does.
    id: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_.-]+$' },
    name: { type: 'string', minLength: 1, maxLength: 250 },
    description: { type: 'string', maxLength: 2000 },
    active: { type: 'boolean' },
    metadata: metadataSchema,
  },
}

const priceSpecSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lookupKey', 'product', 'currency', 'unitAmountCents'],
  properties: {
    lookupKey: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_.-]+$' },
    product: { type: 'string', minLength: 1, maxLength: 200 },
    // A pattern rather than an enum: the set of Stripe currencies changes, and a
    // stale enum would reject a valid document.
    currency: { type: 'string', pattern: '^[a-z]{3}$' },
    unitAmountCents: { type: 'integer', minimum: 0, maximum: 99999999 },
    recurring: {
      type: 'object',
      additionalProperties: false,
      required: ['interval'],
      properties: { interval: { enum: [...STRIPE_INTERVALS] } },
    },
    active: { type: 'boolean' },
    nickname: { type: 'string', maxLength: 250 },
    metadata: metadataSchema,
  },
}

export const stripeCatalogSpecSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    credentials: {
      type: 'object',
      additionalProperties: false,
      required: ['secretRef'],
      properties: {
        secretRef: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 128 },
            key: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    products: { type: 'array', maxItems: 200, items: productSpecSchema },
    prices: { type: 'array', maxItems: 200, items: priceSpecSchema },
  },
}

export const stripeResourceTypes: ResourceTypeDefinition[] = [
  {
    name: STRIPE_RESOURCE_TYPES.product,
    provider: STRIPE_PROVIDER_NAME,
    description: 'A Stripe product: the thing being sold, independent of what it costs',
    capabilities: {
      inspect: true,
      plan: true,
      apply: true,
      verify: true,
      // Stripe refuses to delete a product that has any user-created price, and
      // archiving is the operation people actually mean. Declaring `false` makes the
      // runtime block a deletion and show it, instead of the provider discovering
      // the refusal mid-apply.
      delete: false,
    },
    identityFields: ['id'],
    immutableFields: ['id'],
    sensitiveFields: [],
    riskFactors: { financial: true, externallyVisible: true },
    attributeSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'active'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: ['string', 'null'] },
        active: { type: 'boolean' },
        metadata: metadataSchema,
      },
    },
  },
  {
    name: STRIPE_RESOURCE_TYPES.price,
    provider: STRIPE_PROVIDER_NAME,
    description: 'A Stripe price: an immutable financial record attached to a product',
    capabilities: {
      inspect: true,
      plan: true,
      apply: true,
      verify: true,
      // A price cannot be deleted through the Stripe API at all — only archived.
      delete: false,
    },
    identityFields: ['lookupKey'],
    // Verified against the Stripe API reference: after creation only `metadata`,
    // `nickname` and `active` can be updated. Everything else is fixed, because a
    // price is kept as an immutable record of past transactions.
    immutableFields: ['lookupKey', 'product', 'currency', 'unitAmountCents', 'recurring'],
    sensitiveFields: [],
    riskFactors: { financial: true, externallyVisible: true },
    attributeSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['lookupKey', 'product', 'currency', 'unitAmountCents', 'active'],
      properties: {
        lookupKey: { type: 'string' },
        product: { type: 'string' },
        currency: { type: 'string' },
        unitAmountCents: { type: 'integer' },
        recurring: {
          oneOf: [
            { type: 'null' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['interval'],
              properties: { interval: { enum: [...STRIPE_INTERVALS] } },
            },
          ],
        },
        active: { type: 'boolean' },
        nickname: { type: ['string', 'null'] },
        metadata: metadataSchema,
      },
    },
  },
]

export const stripeCatalogKind: KindDefinition = {
  kind: STRIPE_KIND,
  provider: STRIPE_PROVIDER_NAME,
  description: 'A Stripe product catalogue: products and the prices attached to them',
  specSchema: stripeCatalogSpecSchema,
  resourceTypes: Object.values(STRIPE_RESOURCE_TYPES),
}
