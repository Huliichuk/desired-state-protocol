import { afterEach, describe, expect, it } from 'vitest'
import { DSPError, type DesiredStateContract } from '@dsp/protocol'
import { computePlanHash } from '@dsp/plan-engine'
import type { MockWorkspaceSpec } from '@dsp/provider-mock'
import { AGENT, WORKSPACE, createHarness, document, type Harness } from './harness.js'

const harnesses: Harness[] = []

function harness(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const created = createHarness(options)
  harnesses.push(created)
  return created
}

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.close()
})

const BILLING_SPEC: MockWorkspaceSpec = {
  users: [{ email: 'founder@example.com', role: 'admin' }],
  subscriptions: [
    { user: 'founder@example.com', plan: 'pro', amountCents: 2900, currency: 'eur', active: false },
  ],
}

const ACTIVE_SPEC: MockWorkspaceSpec = {
  ...BILLING_SPEC,
  subscriptions: [{ ...BILLING_SPEC.subscriptions![0]!, active: true }],
}

const BILLING_WORKS =
  'resources.exists(r, r.type == "mock.subscription" && r.attributes.active == true)'
const PRICE_CAP = (limit: number) =>
  `resources.filter(r, r.type == "mock.subscription").all(s, s.attributes.amountCents <= ${limit})`

function withContract(spec: MockWorkspaceSpec, contract: DesiredStateContract) {
  return { ...document(spec), contract }
}

describe('the gap a contract closes', () => {
  it('reports success for a document whose goal is unmet, without a contract', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(BILLING_SPEC), actor: AGENT })
    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      actor: AGENT,
    })

    // Structurally perfect: the world matches the document exactly.
    expect(operation.status).toBe('completed')
    expect(operation.verification?.status).toBe('satisfied')
    expect(operation.verification?.satisfaction).toBe(1)
    expect(operation.verification?.contract).toBeNull()

    // And nobody can be billed.
    expect(
      h.backend.get(WORKSPACE, 'mock.subscription/founder@example.com')?.attributes['active'],
    ).toBe(false)
  })

  it('reports goal_not_satisfied for the same document once it declares its goal', async () => {
    const h = harness()
    const desiredState = withContract(BILLING_SPEC, {
      goal: 'the founder can be billed monthly',
      success: [
        { id: 'billing-active', expression: BILLING_WORKS, message: 'no active subscription' },
      ],
    })

    const plan = await h.runtime.plan({ desiredState, actor: AGENT })
    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      actor: AGENT,
    })

    expect(operation.status).toBe('goal_not_satisfied')
    // Structural verification still passes, and says so: the two claims are separate.
    expect(operation.verification?.status).toBe('satisfied')
    expect(operation.verification?.satisfaction).toBe(1)
    expect(operation.verification?.contract).toMatchObject({
      goal: 'the founder can be billed monthly',
      satisfied: false,
    })
    expect(operation.verification?.contract?.predicates[0]).toMatchObject({
      id: 'billing-active',
      satisfied: false,
      message: 'no active subscription',
      error: null,
    })
  })

  it('completes when the document actually achieves the goal', async () => {
    const h = harness()
    const desiredState = withContract(ACTIVE_SPEC, {
      goal: 'the founder can be billed monthly',
      success: [{ id: 'billing-active', expression: BILLING_WORKS }],
    })

    const plan = await h.runtime.plan({ desiredState, actor: AGENT })
    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      actor: AGENT,
    })

    expect(operation.status).toBe('completed')
    expect(operation.verification?.contract?.satisfied).toBe(true)
  })
})

describe('constraints', () => {
  it('carries the goal and the constraint result into the plan', async () => {
    const h = harness()
    const plan = await h.runtime.plan({
      desiredState: withContract(BILLING_SPEC, {
        goal: 'billing under a hundred euro',
        constraints: [{ id: 'cap', expression: PRICE_CAP(10000) }],
      }),
      actor: AGENT,
    })

    expect(plan.contract).toMatchObject({ goal: 'billing under a hundred euro', satisfied: true })
    expect(plan.executable).toBe(true)
  })

  it('makes a self-contradictory document non-executable', async () => {
    const h = harness()
    const plan = await h.runtime.plan({
      desiredState: withContract(BILLING_SPEC, {
        goal: 'billing under ten euro',
        constraints: [{ id: 'cap', expression: PRICE_CAP(1000), message: 'too expensive' }],
      }),
      actor: AGENT,
    })

    expect(plan.contract?.satisfied).toBe(false)
    expect(plan.executable).toBe(false)

    // And it cannot be applied, for the same reason a policy denial cannot.
    try {
      await h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT })
      expect.unreachable('a non-executable plan must not apply')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('PLAN_NOT_EXECUTABLE')
    }
  })

  it('is a self-check, not an access control: a weak constraint changes nothing about policy', async () => {
    // The document declares a constraint it trivially satisfies. Policy is still
    // what decides, and a client cannot influence it.
    const h = harness()
    const plan = await h.runtime.plan({
      desiredState: withContract(BILLING_SPEC, {
        constraints: [{ id: 'trivial', expression: 'true' }],
      }),
      actor: AGENT,
    })

    expect(plan.contract?.satisfied).toBe(true)
    expect(plan.metadata.policyBundleHash).toBe(h.runtime.policyBundleHash())
  })

  it('evaluates constraints against the desired state, before anything is applied', async () => {
    const h = harness()
    await h.runtime.plan({
      desiredState: withContract(BILLING_SPEC, {
        constraints: [{ id: 'cap', expression: PRICE_CAP(1000) }],
      }),
      actor: AGENT,
    })
    // Planning never touches the world, contract or not.
    expect(h.backend.list(WORKSPACE)).toEqual([])
  })
})

describe('the plan hash covers the contract', () => {
  it('recomputes to the published hash', async () => {
    const h = harness()
    const plan = await h.runtime.plan({
      desiredState: withContract(BILLING_SPEC, {
        goal: 'g',
        success: [{ id: 's', expression: 'true' }],
      }),
      actor: AGENT,
    })
    const record = await h.store.getPlan(plan.metadata.id)
    if (record === null) expect.unreachable('the plan must be stored')
    else expect(computePlanHash(record.plan)).toBe(record.plan.metadata.planHash)
  })

  it('changes when the goal changes, so an approval cannot carry across intents', async () => {
    const h = harness()
    const first = await h.runtime.plan({
      desiredState: withContract(BILLING_SPEC, { goal: 'one thing' }),
      actor: AGENT,
    })
    const second = await h.runtime.plan({
      desiredState: withContract(BILLING_SPEC, { goal: 'a different thing' }),
      actor: AGENT,
    })

    expect(second.metadata.planHash).not.toBe(first.metadata.planHash)
    expect(second.metadata.id).not.toBe(first.metadata.id)
  })

  it('changes when a constraint changes', async () => {
    const h = harness()
    const lenient = await h.runtime.plan({
      desiredState: withContract(BILLING_SPEC, {
        constraints: [{ id: 'c', expression: PRICE_CAP(10000) }],
      }),
      actor: AGENT,
    })
    const strict = await h.runtime.plan({
      desiredState: withContract(BILLING_SPEC, {
        constraints: [{ id: 'c', expression: PRICE_CAP(5000) }],
      }),
      actor: AGENT,
    })
    expect(strict.metadata.planHash).not.toBe(lenient.metadata.planHash)
  })

  it('stays identical for the same contract, so planning is still deterministic', async () => {
    const h = harness()
    const contract: DesiredStateContract = {
      goal: 'stable',
      constraints: [{ id: 'c', expression: PRICE_CAP(10000) }],
      success: [{ id: 's', expression: BILLING_WORKS }],
    }
    const first = await h.runtime.plan({
      desiredState: withContract(BILLING_SPEC, contract),
      actor: AGENT,
    })
    const second = await h.runtime.plan({
      desiredState: withContract(BILLING_SPEC, contract),
      actor: AGENT,
    })

    expect(second.metadata.planHash).toBe(first.metadata.planHash)
    expect(second.contract).toEqual(first.contract)
  })
})

describe('a broken contract is reported, not guessed at', () => {
  it('fails validation with the path of the offending expression', async () => {
    const h = harness()
    const result = await h.runtime.validate({
      desiredState: withContract(BILLING_SPEC, {
        success: [{ id: 'broken', expression: 'resources.exists(r,' }],
      }),
      actor: AGENT,
    })

    expect(result.valid).toBe(false)
    expect(result.errors[0]).toMatchObject({
      code: 'CONTRACT_PREDICATE_INVALID',
      path: 'contract.success[0].expression',
    })
  })

  it('refuses to plan a document whose contract cannot be evaluated', async () => {
    const h = harness()
    try {
      await h.runtime.plan({
        desiredState: withContract(BILLING_SPEC, {
          constraints: [{ id: 'broken', expression: '((((' }],
        }),
        actor: AGENT,
      })
      expect.unreachable('an unevaluable contract must be refused')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('CONTRACT_PREDICATE_INVALID')
    }
  })

  it('treats a predicate that errors at evaluation time as unsatisfied, and says why', async () => {
    const h = harness()
    const desiredState = withContract(BILLING_SPEC, {
      success: [{ id: 'typo', expression: 'resources.exists(r, r.attributes.actve == true)' }],
    })
    const plan = await h.runtime.plan({ desiredState, actor: AGENT })
    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      actor: AGENT,
    })

    expect(operation.status).toBe('goal_not_satisfied')
    const result = operation.verification?.contract?.predicates[0]
    expect(result?.satisfied).toBe(false)
    // Not silently false: the typo is named.
    expect(result?.error).toContain('actve')
  })

  it('warns rather than fails when a contract declares nothing', async () => {
    const h = harness()
    const result = await h.runtime.validate({
      desiredState: withContract(BILLING_SPEC, {}),
      actor: AGENT,
    })
    expect(result.valid).toBe(true)
    expect(result.warnings.some((issue) => issue.code === 'EMPTY_CONTRACT')).toBe(true)
  })
})

describe('precedence between structural and goal failure', () => {
  it('reports the structural failure when both are wrong', async () => {
    const h = harness()
    // Drift rewrites `region`, so it has to land on a resource that declares one —
    // verification ignores observed attributes the document never asked for.
    const desiredState = withContract(
      {
        ...BILLING_SPEC,
        databases: [{ name: 'main', engine: 'postgres', region: 'eu-central-1' }],
        simulate: { driftResourceKey: 'mock.database/main' },
      },
      { success: [{ id: 'billing-active', expression: BILLING_WORKS }] },
    )
    const plan = await h.runtime.plan({ desiredState, actor: AGENT })
    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      actor: AGENT,
    })

    expect(operation.verification?.contract?.satisfied).toBe(false)
    expect(['verification_failed', 'partially_completed']).toContain(operation.status)
    expect(operation.status).not.toBe('goal_not_satisfied')
  })
})
