import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DSPError, type DSPPlan } from '@dsp/protocol'
import { computePlanHash } from '@dsp/plan-engine'
import { AGENT, BASE_SPEC, HUMAN, createHarness, document, type Harness } from './harness.js'

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  harness.close()
})

async function planBase(): Promise<DSPPlan> {
  return harness.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
}

async function applyBase(plan: DSPPlan, idempotencyKey = 'key-1') {
  return harness.runtime.apply({ planId: plan.metadata.id, idempotencyKey, actor: AGENT })
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<DSPError> {
  try {
    await promise
    expect.unreachable(`the call must fail with ${code}`)
  } catch (error) {
    if (!DSPError.isDSPError(error)) throw error
    expect(error.code).toBe(code)
    return error
  }
}

describe('the happy path', () => {
  it('validates, plans, applies and verifies a workspace end to end', async () => {
    const desiredState = document(BASE_SPEC)

    const validation = await harness.runtime.validate({ desiredState, actor: AGENT })
    expect(validation.valid).toBe(true)

    const before = await harness.runtime.inspect({ desiredState, actor: AGENT })
    expect(before.revision).toBe('empty')

    const plan = await planBase()
    expect(plan.summary.create).toBe(4)
    expect(plan.summary.blocked).toBe(0)
    expect(plan.executable).toBe(true)
    expect(plan.approvals.required).toBe(false)

    const operation = await applyBase(plan)
    expect(operation.status).toBe('completed')
    expect(operation.changes.every((change) => change.status === 'succeeded')).toBe(true)
    expect(operation.verification?.status).toBe('satisfied')
    expect(operation.verification?.satisfaction).toBe(1)

    // The world actually changed.
    expect(harness.backend.list({ namespace: 'default', workspace: 'demo' })).toHaveLength(4)
  })

  it('records the provider request id and external id for every change', async () => {
    const operation = await applyBase(await planBase())
    for (const change of operation.changes) {
      expect(change.externalId, change.resourceKey).toBeTruthy()
      expect(change.providerRequestId, change.resourceKey).toMatch(/^mockreq_/)
      expect(change.attempts).toBe(1)
    }
  })

  it('reports nothing left to do once the desired state holds', async () => {
    await applyBase(await planBase())

    const second = await planBase()
    expect(second.summary).toMatchObject({ create: 0, update: 0, noop: 4, blocked: 0 })
    expect(second.summary.risk).toBe('low')
  })

  it('applies an update without recreating anything', async () => {
    await applyBase(await planBase())

    const updated = document({
      ...BASE_SPEC,
      databases: [{ ...BASE_SPEC.databases![0]!, sizeGb: 40 }],
    })
    const plan = await harness.runtime.plan({ desiredState: updated, actor: AGENT })
    expect(plan.summary).toMatchObject({ create: 0, update: 1, noop: 3 })

    const operation = await harness.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'update-1',
      actor: AGENT,
    })
    expect(operation.status).toBe('completed')
    expect(
      harness.backend.get({ namespace: 'default', workspace: 'demo' }, 'mock.database/main')
        ?.attributes['sizeGb'],
    ).toBe(40)
  })
})

describe('plan has no side effects', () => {
  it('leaves the world untouched, however many times it runs', async () => {
    const first = await planBase()
    const second = await planBase()

    expect(harness.backend.list({ namespace: 'default', workspace: 'demo' })).toEqual([])
    expect(second.metadata.planHash).toBe(first.metadata.planHash)
    expect(second.metadata.id).toBe(first.metadata.id)
  })

  it('leaves the world untouched during validate and inspect', async () => {
    const desiredState = document(BASE_SPEC)
    await harness.runtime.validate({ desiredState, actor: AGENT })
    await harness.runtime.inspect({ desiredState, actor: AGENT })
    expect(harness.backend.list({ namespace: 'default', workspace: 'demo' })).toEqual([])
  })

  it('keeps the plan id stable across clock movement but refreshes the expiry', async () => {
    const first = await planBase()
    harness.advance(60_000)
    const second = await planBase()

    expect(second.metadata.id).toBe(first.metadata.id)
    // The stored plan is reused while it is still valid, so it keeps its expiry.
    expect(second.metadata.expiresAt).toBe(first.metadata.expiresAt)
  })
})

describe('apply accepts a plan id and nothing else', () => {
  it('refuses an unknown plan id', async () => {
    const error = await expectCode(
      harness.runtime.apply({
        planId: 'plan_' + '0'.repeat(24),
        idempotencyKey: 'k',
        actor: AGENT,
      }),
      'PLAN_NOT_FOUND',
    )
    expect(error.details?.['planId']).toBe('plan_' + '0'.repeat(24))
  })

  it('requires a non-empty idempotency key', async () => {
    const plan = await planBase()
    await expectCode(
      harness.runtime.apply({ planId: plan.metadata.id, idempotencyKey: '   ', actor: AGENT }),
      'IDEMPOTENCY_KEY_REQUIRED',
    )
  })

  it('refuses a plan whose stored hash no longer matches its contents', async () => {
    const plan = await planBase()
    const record = await harness.store.getPlan(plan.metadata.id)
    if (record === null) expect.unreachable('the plan must have been stored')
    else {
      const first = record.plan.changes[0]
      if (first !== undefined) first.after = { name: 'hijacked' }
      await harness.store.savePlan(record)
    }

    await expectCode(applyBase(plan), 'PLAN_HASH_MISMATCH')
  })

  it('refuses a plan that was not executable when it was created', async () => {
    const denying = createHarness({
      policyBundle: {
        policies: [
          {
            apiVersion: 'dsp.dev/v1alpha1',
            kind: 'Policy',
            metadata: { name: 'deny-all' },
            spec: { rules: [{ id: 'deny', effect: 'deny', message: 'nothing may change' }] },
          },
        ],
      },
    })

    try {
      const plan = await denying.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
      expect(plan.executable).toBe(false)
      await expectCode(
        denying.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT }),
        'PLAN_NOT_EXECUTABLE',
      )
    } finally {
      denying.close()
    }
  })
})

describe('plan expiry', () => {
  it('refuses to apply a plan past its TTL', async () => {
    const plan = await planBase()
    harness.advance(16 * 60 * 1000)

    const error = await expectCode(applyBase(plan), 'PLAN_EXPIRED')
    expect(error.details?.['expiresAt']).toBe(plan.metadata.expiresAt)
  })

  it('refuses to approve a plan past its TTL', async () => {
    const plan = await planBase()
    harness.advance(16 * 60 * 1000)

    await expectCode(
      harness.runtime.approve({
        planId: plan.metadata.id,
        approvedBy: 'reviewer',
        reason: 'late',
        planHash: plan.metadata.planHash,
        actor: HUMAN,
      }),
      'PLAN_EXPIRED',
    )
  })

  it('re-plans an expired plan with a fresh expiry under the same id', async () => {
    const first = await planBase()
    harness.advance(16 * 60 * 1000)

    const second = await planBase()
    expect(second.metadata.id).toBe(first.metadata.id)
    expect(second.metadata.expiresAt).not.toBe(first.metadata.expiresAt)

    const operation = await applyBase(second)
    expect(operation.status).toBe('completed')
  })
})

describe('plan integrity', () => {
  it('publishes a hash that covers its own contents', async () => {
    const record = await harness.store.getPlan((await planBase()).metadata.id)
    if (record === null) expect.unreachable('the plan must have been stored')
    else expect(computePlanHash(record.plan)).toBe(record.plan.metadata.planHash)
  })

  it('binds the plan to the policy bundle it was evaluated under', async () => {
    const plan = await planBase()
    expect(plan.metadata.policyBundleHash).toBe(harness.runtime.policyBundleHash())
  })

  it('records the revision it observed while planning', async () => {
    expect((await planBase()).metadata.currentRevision).toBe('empty')
  })
})
