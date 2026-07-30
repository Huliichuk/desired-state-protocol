import type { SecretReference } from '@dsp/protocol'

/**
 * The Stripe product catalogue as desired state.
 *
 * Scoped to products and prices on purpose. They are the part of Stripe that
 * stresses DSP hardest: a Price is an immutable financial record that cannot be
 * deleted, only archived, and almost every field on it is fixed at creation.
 */
export interface StripeCatalogSpec {
  credentials?: { secretRef: SecretReference }
  products?: StripeProductSpec[]
  prices?: StripePriceSpec[]
}

export interface StripeProductSpec {
  /**
   * Client-chosen Stripe id. Stripe generates one when omitted, but DSP needs a
   * stable key that exists before the resource does, so declaring it is required
   * here rather than optional.
   */
  id: string
  name: string
  description?: string
  active?: boolean
  metadata?: Record<string, string>
}

export interface StripePriceSpec {
  /**
   * Stripe's own client-chosen handle for a price. Prices have no settable id, so
   * this is the only stable identity available.
   */
  lookupKey: string
  /** `id` of a product declared in the same document. */
  product: string
  /** Three-letter ISO code, lowercase. Immutable once the price exists. */
  currency: string
  /** Smallest currency unit. Immutable once the price exists. */
  unitAmountCents: number
  /** Omit for a one-off price. Immutable once the price exists. */
  recurring?: { interval: StripeInterval }
  active?: boolean
  nickname?: string
  metadata?: Record<string, string>
}

export type StripeInterval = 'day' | 'week' | 'month' | 'year'

export const STRIPE_INTERVALS: readonly StripeInterval[] = ['day', 'week', 'month', 'year']

/** What `inspect` reports: the resources in Stripe that this document owns. */
export interface StripeCatalogState {
  products: StripeProductState[]
  prices: StripePriceState[]
}

export interface StripeProductState {
  id: string
  name: string
  description: string | null
  active: boolean
  metadata: Record<string, string>
}

export interface StripePriceState {
  id: string
  lookupKey: string | null
  product: string
  currency: string
  unitAmountCents: number | null
  recurring: { interval: StripeInterval } | null
  active: boolean
  nickname: string | null
  metadata: Record<string, string>
}

export const STRIPE_PROVIDER_NAME = 'stripe'

export const STRIPE_RESOURCE_TYPES = {
  product: 'stripe.product',
  price: 'stripe.price',
} as const

export const STRIPE_KIND = 'StripeCatalog'

/**
 * Metadata key marking a resource as managed by one DSP document.
 *
 * Without it, `inspect` would have to report every product in the account, and a
 * document that declares three products would generate a blocked deletion for
 * every unrelated one. With it, DSP sees only what it created: resources it never
 * touched stay invisible, and a resource it created and the document stopped
 * declaring correctly shows up as a deletion.
 *
 * This is resource ownership invented at the provider level because the protocol
 * does not define it yet. Every provider that talks to a shared account will have
 * to invent the same thing, differently — which is the argument for specifying it
 * once.
 */
export const OWNER_METADATA_KEY = 'dsp_owner'
