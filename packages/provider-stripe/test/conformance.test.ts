import { runProviderConformanceSuite } from '@dsp/provider-sdk/conformance'
import { DSP_API_VERSION, type DesiredStateDocument } from '@dsp/protocol'
import { StripeProvider, type StripeCatalogSpec } from '@dsp/provider-stripe'
import { StripeStub } from './stripe-stub.js'

const API_KEY = ['sk', 'test', 'stubKeyForConformance1234'].join('_')

const spec = (prices: StripeCatalogSpec['prices']): StripeCatalogSpec => ({
  credentials: { secretRef: { name: 'stripe-test' } },
  products: [{ id: 'pro-plan', name: 'Pro plan' }],
  prices,
})

const document = (value: StripeCatalogSpec): DesiredStateDocument<StripeCatalogSpec> => ({
  apiVersion: DSP_API_VERSION,
  kind: 'StripeCatalog',
  metadata: { name: 'catalogue' },
  spec: value,
})

const PRICE = {
  lookupKey: 'pro-monthly-eur',
  product: 'pro-plan',
  currency: 'eur',
  unitAmountCents: 2900,
  recurring: { interval: 'month' as const },
}

// The same suite the mock provider passes. It is the only check that this adapter
// obeys the protocol rather than just working.
runProviderConformanceSuite<StripeCatalogSpec, never>({
  name: 'stripe',
  createProvider: () => new StripeProvider({ transport: new StripeStub() }) as never,
  validDocument: () => document(spec([PRICE])),
  // Dropping the price asks DSP to remove a resource Stripe will not delete.
  documentWithResourceRemoved: () => document(spec([])),
  secretValues: { 'stripe-test': API_KEY },
})
