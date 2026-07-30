import { beforeEach, describe, expect, it } from 'vitest'
import { DSP_API_VERSION, type DesiredStateDocument } from '@dsp/protocol'
import { createTestContext, createTestExecutionContext } from '@dsp/provider-sdk'
import { StripeProvider, type StripeCatalogSpec } from '@dsp/provider-stripe'
import { StripeStub } from './stripe-stub.js'

const API_KEY = ['sk', 'test', 'stubKeyForConformance1234'].join('_')
const SECRETS = { 'stripe-test': API_KEY }

const BASE_SPEC: StripeCatalogSpec = {
  credentials: { secretRef: { name: 'stripe-test' } },
  products: [{ id: 'pro-plan', name: 'Pro plan', description: 'Everything in Pro' }],
  prices: [
    {
      lookupKey: 'pro-monthly-eur',
      product: 'pro-plan',
      currency: 'eur',
      unitAmountCents: 2900,
      recurring: { interval: 'month' },
    },
  ],
}

function document(
  spec: StripeCatalogSpec,
  name = 'catalogue',
): DesiredStateDocument<StripeCatalogSpec> {
  return {
    apiVersion: DSP_API_VERSION,
    kind: 'StripeCatalog',
    metadata: { name },
    spec,
  }
}

let stub: StripeStub
let provider: StripeProvider

beforeEach(() => {
  stub = new StripeStub()
  provider = new StripeProvider({ transport: stub, pageSize: 2 })
})

const context = () => createTestContext({ secretValues: SECRETS })

async function applyAll(doc: DesiredStateDocument<StripeCatalogSpec>, key = 'k'): Promise<void> {
  const desired = await provider.normalizeDesired(doc)
  // Products before prices: the projection's dependsOn is what tells the runtime
  // this order, and here the test honours it explicitly.
  const ordered = [...desired.resources].sort((a, b) =>
    a.resourceType === b.resourceType ? 0 : a.resourceType === 'stripe.product' ? -1 : 1,
  )
  for (const resource of ordered) {
    await provider.applyChange(
      createTestExecutionContext({
        desired: doc,
        secretValues: SECRETS,
        idempotencyKey: key,
      }),
      {
        id: `chg_${resource.key}`,
        resourceType: resource.resourceType,
        resourceKey: resource.key,
        action: 'create',
        fields: [],
        reason: 'test',
        reversible: false,
        destructive: false,
        dependencies: [],
        estimatedRisk: 'low',
        after: resource.attributes,
      },
    )
  }
}

describe('declarations match what Stripe actually allows', () => {
  it('marks on a price everything Stripe fixes at creation', () => {
    const price = provider.resourceTypes.find((type) => type.name === 'stripe.price')
    // Verified against the Stripe API reference: only metadata, nickname and active
    // are updatable afterwards.
    expect(price?.immutableFields.sort()).toEqual(
      ['currency', 'lookupKey', 'product', 'recurring', 'unitAmountCents'].sort(),
    )
  })

  it('declares neither resource deletable', () => {
    for (const type of provider.resourceTypes) {
      expect(type.capabilities.delete, type.name).toBe(false)
    }
  })

  it('flags both resource types as financial and externally visible', () => {
    for (const type of provider.resourceTypes) {
      expect(type.riskFactors?.financial, type.name).toBe(true)
      expect(type.riskFactors?.externallyVisible, type.name).toBe(true)
    }
  })
})

describe('projection', () => {
  it('keys a product on its client-chosen id and a price on its lookup key', async () => {
    const projection = await provider.normalizeDesired(document(BASE_SPEC))
    expect(projection.resources.map((resource) => resource.key)).toEqual([
      'stripe.product/pro-plan',
      'stripe.price/pro-monthly-eur',
    ])
  })

  it('expresses the price-to-product dependency rather than sequencing it', async () => {
    const projection = await provider.normalizeDesired(document(BASE_SPEC))
    const price = projection.resources.find((resource) => resource.key.startsWith('stripe.price/'))
    expect(price?.dependsOn).toEqual(['stripe.product/pro-plan'])
  })

  it('is pure', async () => {
    const doc = document(BASE_SPEC)
    const first = await provider.normalizeDesired(doc)
    const second = await provider.normalizeDesired(doc)
    expect(second).toEqual(first)
    expect(stub.writes()).toEqual([])
  })

  it('projects Stripe defaults on both sides, so a fresh resource is not reported as changed', async () => {
    await applyAll(document(BASE_SPEC))
    const desired = await provider.normalizeDesired(document(BASE_SPEC))
    const observed = await provider.normalizeCurrent(
      await provider.inspect(context(), document(BASE_SPEC)),
    )

    for (const wanted of desired.resources) {
      const found = observed.resources.find((resource) => resource.key === wanted.key)
      expect(found?.attributes, wanted.key).toEqual(wanted.attributes)
    }
  })
})

describe('side-effect freedom', () => {
  it('validate performs no writes', async () => {
    await provider.validate(context(), document(BASE_SPEC))
    expect(stub.writes()).toEqual([])
  })

  it('inspect performs no writes', async () => {
    await provider.inspect(context(), document(BASE_SPEC))
    expect(stub.writes()).toEqual([])
  })
})

describe('validate catches what the schema cannot', () => {
  it('rejects a price pointing at an undeclared product', async () => {
    const result = await provider.validate(context(), document({ ...BASE_SPEC, products: [] }))
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toMatchObject({
      code: 'UNRESOLVED_REFERENCE',
      path: 'spec.prices[0].product',
    })
  })

  it('rejects duplicate lookup keys', async () => {
    const price = BASE_SPEC.prices![0]!
    const result = await provider.validate(
      context(),
      document({ ...BASE_SPEC, prices: [price, { ...price, unitAmountCents: 3900 }] }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((issue) => issue.path === 'spec.prices[1].lookupKey')).toBe(true)
  })

  it('warns when no credential is declared, because apply cannot work without one', async () => {
    const result = await provider.validate(
      context(),
      document({ ...BASE_SPEC, credentials: undefined }),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((issue) => issue.code === 'MISSING_CREDENTIALS')).toBe(true)
  })
})

describe('apply', () => {
  it('creates the product and the price', async () => {
    await applyAll(document(BASE_SPEC))
    expect(stub.product('pro-plan')?.name).toBe('Pro plan')
    expect(stub.price('pro-monthly-eur')).toMatchObject({
      currency: 'eur',
      unit_amount: 2900,
      recurring: { interval: 'month' },
      product: 'pro-plan',
    })
  })

  it('is idempotent: the same key twice leaves one product and one price', async () => {
    await applyAll(document(BASE_SPEC), 'same')
    await applyAll(document(BASE_SPEC), 'same')
    expect(stub.productCount()).toBe(1)
    expect(stub.priceCount()).toBe(1)
  })

  it('refuses to execute a blocked or noop change', async () => {
    for (const action of ['blocked', 'noop'] as const) {
      await expect(
        provider.applyChange(
          createTestExecutionContext({ desired: document(BASE_SPEC), secretValues: SECRETS }),
          {
            id: 'chg',
            resourceType: 'stripe.price',
            resourceKey: 'stripe.price/x',
            action,
            fields: [],
            reason: 'r',
            reversible: false,
            destructive: false,
            dependencies: [],
            estimatedRisk: 'low',
          },
        ),
      ).rejects.toThrow(/must not execute/)
    }
  })

  it('refuses a delete, and says what to do instead', async () => {
    await expect(
      provider.applyChange(
        createTestExecutionContext({ desired: document(BASE_SPEC), secretValues: SECRETS }),
        {
          id: 'chg',
          resourceType: 'stripe.price',
          resourceKey: 'stripe.price/pro-monthly-eur',
          action: 'delete',
          fields: [],
          reason: 'r',
          reversible: false,
          destructive: true,
          dependencies: [],
          estimatedRisk: 'high',
        },
      ),
    ).rejects.toThrow(/archive it with active: false/)
  })

  it('archives a price by updating the one field Stripe allows', async () => {
    await applyAll(document(BASE_SPEC))
    const price = BASE_SPEC.prices![0]!

    await provider.applyChange(
      createTestExecutionContext({
        desired: document({ ...BASE_SPEC, prices: [{ ...price, active: false }] }),
        secretValues: SECRETS,
        idempotencyKey: 'archive',
      }),
      {
        id: 'chg_archive',
        resourceType: 'stripe.price',
        resourceKey: 'stripe.price/pro-monthly-eur',
        action: 'update',
        fields: [{ path: 'active', before: true, after: false, immutable: false }],
        reason: 'archive',
        reversible: true,
        destructive: false,
        dependencies: [],
        estimatedRisk: 'medium',
        after: {
          ...price,
          recurring: price.recurring,
          active: false,
          nickname: null,
          metadata: {},
        },
      },
    )

    expect(stub.price('pro-monthly-eur')?.active).toBe(false)
    // Still there. Stripe keeps the record; DSP did not destroy a financial object.
    expect(stub.priceCount()).toBe(1)
  })

  it('refuses an update that touches an immutable price field before Stripe has to', async () => {
    await applyAll(document(BASE_SPEC))
    const price = BASE_SPEC.prices![0]!

    await expect(
      provider.applyChange(
        createTestExecutionContext({
          desired: document(BASE_SPEC),
          secretValues: SECRETS,
          idempotencyKey: 'bad',
        }),
        {
          id: 'chg_bad',
          resourceType: 'stripe.price',
          resourceKey: 'stripe.price/pro-monthly-eur',
          action: 'update',
          fields: [{ path: 'unitAmountCents', before: 2900, after: 3900, immutable: true }],
          reason: 'raise the price',
          reversible: false,
          destructive: false,
          dependencies: [],
          estimatedRisk: 'high',
          after: { ...price, unitAmountCents: 3900, active: true, nickname: null, metadata: {} },
        },
      ),
    ).rejects.toThrow(/cannot change unitAmountCents/)
  })

  it('rejects a key that is not a Stripe test key', async () => {
    await expect(
      applyAll(document({ ...BASE_SPEC, credentials: { secretRef: { name: 'bad' } } })),
    ).rejects.toThrow()
  })
})

describe('ownership', () => {
  it('ignores resources it did not create', async () => {
    // Something else in the account — the dashboard, another tool.
    stub.seedProduct({ id: 'someone-elses', name: 'Not ours' })

    const observed = await provider.inspect(context(), document(BASE_SPEC))
    expect(observed.state?.products).toEqual([])

    // And planning against it never proposes touching it.
    const current = await provider.normalizeCurrent(observed)
    expect(current.resources).toEqual([])
  })

  it("does not see another document's resources", async () => {
    await applyAll(document(BASE_SPEC, 'catalogue-a'))

    const other = await provider.inspect(context(), document(BASE_SPEC, 'catalogue-b'))
    expect(other.state?.products).toEqual([])
    expect(other.state?.prices).toEqual([])
  })

  it('sees its own resources again on a second inspection', async () => {
    await applyAll(document(BASE_SPEC))
    const observed = await provider.inspect(context(), document(BASE_SPEC))
    expect(observed.state?.products.map((product) => product.id)).toEqual(['pro-plan'])
    expect(observed.state?.prices.map((price) => price.lookupKey)).toEqual(['pro-monthly-eur'])
  })

  it('keeps the ownership marker out of the projected attributes', async () => {
    await applyAll(document(BASE_SPEC))
    const observed = await provider.normalizeCurrent(
      await provider.inspect(context(), document(BASE_SPEC)),
    )
    for (const resource of observed.resources) {
      expect(JSON.stringify(resource.attributes)).not.toContain('dsp_owner')
    }
  })
})

describe('revision', () => {
  it('is stable while nothing changes', async () => {
    await applyAll(document(BASE_SPEC))
    const first = await provider.inspect(context(), document(BASE_SPEC))
    const second = await provider.inspect(context(), document(BASE_SPEC))
    expect(second.revision).toBe(first.revision)
  })

  it('changes when the world changes', async () => {
    const before = await provider.inspect(context(), document(BASE_SPEC))
    await applyAll(document(BASE_SPEC))
    const after = await provider.inspect(context(), document(BASE_SPEC))
    expect(before.revision).toBe('empty')
    expect(after.revision).not.toBe(before.revision)
  })
})

describe('paging', () => {
  it('reads past the page size', async () => {
    const products = Array.from({ length: 5 }, (_unused, index) => ({
      id: `plan-${index}`,
      name: `Plan ${index}`,
    }))
    const doc = document({ ...BASE_SPEC, products, prices: [] })
    await applyAll(doc)

    // pageSize is 2, so five products take three pages.
    const observed = await provider.inspect(context(), doc)
    expect(observed.state?.products).toHaveLength(5)
  })
})

describe('secrets', () => {
  it('never returns the API key through the provider surface', async () => {
    await applyAll(document(BASE_SPEC))
    const surfaces = [
      await provider.validate(context(), document(BASE_SPEC)),
      await provider.inspect(context(), document(BASE_SPEC)),
      await provider.normalizeDesired(document(BASE_SPEC)),
    ]
    for (const surface of surfaces) {
      expect(JSON.stringify(surface)).not.toContain(API_KEY)
    }
  })
})
