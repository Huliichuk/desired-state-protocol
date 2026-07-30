import { afterEach, describe, expect, it } from 'vitest'
import { DSP_API_VERSION, type DesiredStateDocument } from '@dsp/protocol'
import { createRuntime, type DSPRuntime } from '@dsp/core'
import { EMPTY_POLICY_BUNDLE } from '@dsp/policy-engine'
import { silentLogger } from '@dsp/provider-sdk'
import { MemorySecretStore } from '@dsp/secret-store'
import { StripeProvider, type StripeCatalogSpec } from '@dsp/provider-stripe'
import { StripeStub } from './stripe-stub.js'

/**
 * The whole lifecycle against something that behaves like Stripe, through the real
 * runtime. This is the test that matters: the mock provider was written by the same
 * author as the runtime and cannot falsify its design. Stripe's rules were not.
 */

const API_KEY = ['sk', 'test', 'lifecycleKey1234567890'].join('_')
const ACTOR = { type: 'agent' as const, id: 'test' }

interface Harness {
  runtime: DSPRuntime
  stub: StripeStub
  close(): void
}

const open: Harness[] = []

function harness(): Harness {
  const stub = new StripeStub()
  const secrets = new MemorySecretStore({ 'stripe-test': API_KEY })
  const bundle = createRuntime({
    providers: [new StripeProvider({ transport: stub })],
    policyBundle: EMPTY_POLICY_BUNDLE,
    secretStore: secrets,
    logger: silentLogger,
    config: { environment: 'test', tenant: 'local' },
  })
  const created: Harness = { runtime: bundle.runtime, stub, close: bundle.close }
  open.push(created)
  return created
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close()
})

const PRICE = {
  lookupKey: 'pro-monthly-eur',
  product: 'pro-plan',
  currency: 'eur',
  unitAmountCents: 2900,
  recurring: { interval: 'month' as const },
}

function document(spec: Partial<StripeCatalogSpec> = {}): DesiredStateDocument<StripeCatalogSpec> {
  return {
    apiVersion: DSP_API_VERSION,
    kind: 'StripeCatalog',
    metadata: { name: 'catalogue' },
    spec: {
      credentials: { secretRef: { name: 'stripe-test' } },
      products: [{ id: 'pro-plan', name: 'Pro plan' }],
      prices: [PRICE],
      ...spec,
    },
  }
}

async function applyDocument(
  h: Harness,
  desiredState: DesiredStateDocument<StripeCatalogSpec>,
  idempotencyKey: string,
) {
  const plan = await h.runtime.plan({ desiredState, actor: ACTOR })
  const operation = await h.runtime.apply({
    planId: plan.metadata.id,
    idempotencyKey,
    actor: ACTOR,
  })
  return { plan, operation }
}

describe('the full lifecycle against Stripe rules', () => {
  it('plans the product before the price, from the projection alone', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(), actor: ACTOR })

    expect(plan.changes.map((change) => change.resourceKey)).toEqual([
      'stripe.product/pro-plan',
      'stripe.price/pro-monthly-eur',
    ])
    expect(plan.changes[1]?.dependencies).toEqual([plan.changes[0]?.id])
  })

  it('scores a financial, externally visible catalogue above a trivial one', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(), actor: ACTOR })
    // financial (+15) and externally visible (+5) on both resources, plus
    // irreversible creates. Nothing here is low risk.
    expect(plan.summary.risk).not.toBe('low')
    expect(plan.summary.riskScore).toBeGreaterThan(19)
  })

  it('applies, verifies, and then reports nothing left to do', async () => {
    const h = harness()
    const { operation } = await applyDocument(h, document(), 'first')

    expect(operation.status).toBe('completed')
    expect(operation.verification?.status).toBe('satisfied')
    expect(h.stub.product('pro-plan')?.name).toBe('Pro plan')
    expect(h.stub.price('pro-monthly-eur')?.unit_amount).toBe(2900)

    const again = await h.runtime.plan({ desiredState: document(), actor: ACTOR })
    expect(again.summary).toMatchObject({ create: 0, update: 0, noop: 2 })
  })

  it('returns the same operation for a repeated idempotency key', async () => {
    const h = harness()
    const first = await applyDocument(h, document(), 'repeat')
    const second = await h.runtime.apply({
      planId: first.plan.metadata.id,
      idempotencyKey: 'repeat',
      actor: ACTOR,
    })

    expect(second.id).toBe(first.operation.id)
    expect(h.stub.priceCount()).toBe(1)
  })
})

describe('what Stripe refuses, DSP shows instead of attempting', () => {
  it('blocks a price rise on the same lookup key rather than destroying the record', async () => {
    const h = harness()
    await applyDocument(h, document(), 'initial')

    // The naive edit: same lookup key, new amount. `unitAmountCents` is immutable,
    // so the diff calls this a replace, and replacements are refused by default.
    const plan = await h.runtime.plan({
      desiredState: document({ prices: [{ ...PRICE, unitAmountCents: 3900 }] }),
      actor: ACTOR,
    })

    const change = plan.changes.find((item) => item.resourceType === 'stripe.price')
    expect(change?.action).toBe('blocked')
    expect(change?.blockedBy).toBe('DESTRUCTIVE_ACTION_BLOCKED')
    // The old value is still visible, so a reviewer sees what would have been lost.
    expect(change?.before).toMatchObject({ unitAmountCents: 2900 })
    expect(plan.summary.blocked).toBe(1)
  })

  it('leaves the existing price untouched when that plan is applied', async () => {
    const h = harness()
    await applyDocument(h, document(), 'initial')

    const { operation } = await applyDocument(
      h,
      document({ prices: [{ ...PRICE, unitAmountCents: 3900 }] }),
      'raise',
    )

    expect(operation.status).toBe('partially_completed')
    expect(operation.changes.find((c) => c.resourceType === 'stripe.price')?.status).toBe('blocked')
    // Stripe still holds exactly one price, at the original amount.
    expect(h.stub.priceCount()).toBe(1)
    expect(h.stub.price('pro-monthly-eur')?.unit_amount).toBe(2900)
  })

  it('supports the workflow Stripe actually intends: a new price, the old one archived', async () => {
    const h = harness()
    await applyDocument(h, document(), 'initial')

    // Two prices: the new amount under a new lookup key, and the old one archived.
    const migrated = document({
      prices: [
        { ...PRICE, active: false },
        { ...PRICE, lookupKey: 'pro-monthly-eur-v2', unitAmountCents: 3900 },
      ],
    })

    const plan = await h.runtime.plan({ desiredState: migrated, actor: ACTOR })
    expect(plan.summary).toMatchObject({ create: 1, update: 1, blocked: 0 })

    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'migrate',
      actor: ACTOR,
    })

    expect(operation.status).toBe('completed')
    expect(operation.verification?.status).toBe('satisfied')

    // Both records exist. Nothing was destroyed, and the new price is live.
    expect(h.stub.priceCount()).toBe(2)
    expect(h.stub.price('pro-monthly-eur')?.active).toBe(false)
    expect(h.stub.price('pro-monthly-eur-v2')).toMatchObject({
      unit_amount: 3900,
      active: true,
    })
  })

  it('blocks removing a price from the document instead of deleting it', async () => {
    const h = harness()
    await applyDocument(h, document(), 'initial')

    const plan = await h.runtime.plan({ desiredState: document({ prices: [] }), actor: ACTOR })
    const change = plan.changes.find((item) => item.resourceType === 'stripe.price')

    expect(change?.action).toBe('blocked')
    expect(plan.executable).toBe(true)

    await h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'drop', actor: ACTOR })
    // A price cannot be deleted through the Stripe API at all, and it is still here.
    expect(h.stub.priceCount()).toBe(1)
  })
})

describe('the contract answers what verification cannot', () => {
  it('reports goal_not_satisfied when the catalogue exists but sells nothing', async () => {
    const h = harness()
    const desiredState: DesiredStateDocument<StripeCatalogSpec> = {
      ...document({ prices: [{ ...PRICE, active: false }] }),
      contract: {
        goal: 'the Pro plan can be bought monthly',
        success: [
          {
            id: 'sellable',
            expression:
              'resources.exists(r, r.type == "stripe.price" && r.attributes.active == true)',
            message: 'Every price is archived, so nothing can be bought',
          },
        ],
      },
    }

    const { operation } = await applyDocument(h, desiredState, 'contract')

    // Structurally exact: Stripe holds precisely what was asked for.
    expect(operation.verification?.status).toBe('satisfied')
    expect(operation.verification?.satisfaction).toBe(1)
    // And commercially useless.
    expect(operation.status).toBe('goal_not_satisfied')
    expect(operation.verification?.contract?.predicates[0]?.message).toContain(
      'nothing can be bought',
    )
  })

  it('completes when the catalogue can actually be bought', async () => {
    const h = harness()
    const desiredState: DesiredStateDocument<StripeCatalogSpec> = {
      ...document(),
      contract: {
        goal: 'the Pro plan can be bought monthly',
        constraints: [
          {
            id: 'price-cap',
            expression:
              'resources.filter(r, r.type == "stripe.price").all(p, p.attributes.unitAmountCents <= 10000)',
          },
        ],
        success: [
          {
            id: 'sellable',
            expression:
              'resources.exists(r, r.type == "stripe.price" && r.attributes.active == true)',
          },
        ],
      },
    }

    const { plan, operation } = await applyDocument(h, desiredState, 'contract-ok')
    expect(plan.contract?.satisfied).toBe(true)
    expect(operation.status).toBe('completed')
    expect(operation.verification?.contract?.satisfied).toBe(true)
  })
})

describe('the credential', () => {
  it('never appears in a plan, an operation or an inspection', async () => {
    const h = harness()
    const { plan, operation } = await applyDocument(h, document(), 'secrets')
    const inspected = await h.runtime.inspect({ desiredState: document(), actor: ACTOR })

    for (const surface of [plan, operation, inspected]) {
      expect(JSON.stringify(surface)).not.toContain(API_KEY)
    }
  })

  it('reaches Stripe even though nothing else can see it', async () => {
    const h = harness()
    await applyDocument(h, document(), 'reaches')
    // The write happened, so the provider did resolve and use the real key.
    expect(h.stub.productCount()).toBe(1)
  })
})
