import { describe, expect, it } from 'vitest'
import {
  DSP_API_VERSION,
  type PlanChange,
  type PolicyBundle,
  type PolicyDocument,
  type PolicyEvaluationContext,
  type PolicyRule,
} from '@dsp/protocol'
import { evaluatePolicies, policyBundleHash, sortedPolicies } from '@dsp/policy-engine'

function change(overrides: Partial<PlanChange> = {}): PlanChange {
  return {
    id: 'chg_1',
    resourceType: 'mock.database',
    resourceKey: 'db/main',
    action: 'create',
    fields: [],
    reason: 'r',
    reversible: false,
    destructive: false,
    dependencies: [],
    estimatedRisk: 'low',
    ...overrides,
  }
}

function policy(name: string, ...rules: PolicyRule[]): PolicyDocument {
  return {
    apiVersion: DSP_API_VERSION,
    kind: 'Policy',
    metadata: { name },
    spec: { rules },
  }
}

const context: PolicyEvaluationContext = {
  environment: 'production',
  kind: 'MockWorkspace',
  namespace: 'default',
  resourceName: 'demo',
}

const evaluate = (
  bundle: PolicyBundle,
  changes: PlanChange[],
  overrides: Partial<PolicyEvaluationContext> = {},
) =>
  evaluatePolicies(bundle, {
    changes,
    risk: { score: 10, level: 'low' },
    context: { ...context, ...overrides },
  })

describe('effects', () => {
  it('denies the whole plan when a deny rule matches', () => {
    const result = evaluate(
      {
        policies: [policy('p', { id: 'block-delete', when: { action: 'delete' }, effect: 'deny' })],
      },
      [change({ action: 'delete' })],
    )
    expect(result.allowed).toBe(false)
    expect(result.decisions).toHaveLength(1)
    expect(result.decisions[0]).toMatchObject({
      policyId: 'p',
      ruleId: 'block-delete',
      effect: 'deny',
      changeIds: ['chg_1'],
    })
  })

  it('leaves the plan allowed for warn and allow effects', () => {
    const result = evaluate(
      {
        policies: [
          policy(
            'p',
            { id: 'warn', when: { action: 'create' }, effect: 'warn' },
            { id: 'allow', when: { action: 'create' }, effect: 'allow' },
          ),
        ],
      },
      [change()],
    )
    expect(result.allowed).toBe(true)
    expect(result.decisions.map((decision) => decision.effect)).toEqual(['warn', 'allow'])
    expect(result.requiredApprovals).toEqual([])
  })

  it('turns requireApproval into a requirement carrying minApprovals', () => {
    const result = evaluate(
      {
        policies: [
          policy('p', {
            id: 'needs-two',
            when: { action: 'create' },
            effect: 'requireApproval',
            minApprovals: 2,
          }),
        ],
      },
      [change()],
    )
    expect(result.allowed).toBe(true)
    expect(result.requiredApprovals).toHaveLength(1)
    expect(result.requiredApprovals[0]).toMatchObject({ minApprovals: 2, risk: 'low' })
  })

  it('defaults an approval requirement to a single approval', () => {
    const result = evaluate({ policies: [policy('p', { id: 'a', effect: 'requireApproval' })] }, [
      change(),
    ])
    expect(result.requiredApprovals[0]?.minApprovals).toBe(1)
  })

  it('carries the riskiest matched change into the requirement', () => {
    const result = evaluate({ policies: [policy('p', { id: 'a', effect: 'requireApproval' })] }, [
      change({ id: 'a', estimatedRisk: 'low' }),
      change({ id: 'b', estimatedRisk: 'critical' }),
    ])
    expect(result.requiredApprovals[0]?.risk).toBe('critical')
  })

  it('de-duplicates identical requirements from repeated evaluation', () => {
    const rule: PolicyRule = { id: 'a', effect: 'requireApproval' }
    const result = evaluate({ policies: [policy('p', rule)] }, [
      change({ id: 'a' }),
      change({ id: 'b' }),
    ])
    expect(result.requiredApprovals).toHaveLength(1)
    expect(result.decisions[0]?.changeIds).toEqual(['a', 'b'])
  })

  it('produces no decision at all when a rule does not match', () => {
    const result = evaluate(
      { policies: [policy('p', { id: 'a', when: { action: 'delete' }, effect: 'deny' })] },
      [change({ action: 'create' })],
    )
    expect(result).toEqual({ allowed: true, decisions: [], requiredApprovals: [] })
  })
})

describe('condition matching', () => {
  const denyOn = (when: PolicyRule['when']): PolicyBundle => ({
    policies: [policy('p', { id: 'r', ...(when === undefined ? {} : { when }), effect: 'deny' })],
  })

  it('matches a single action and a list of actions', () => {
    expect(evaluate(denyOn({ action: 'update' }), [change({ action: 'update' })]).allowed).toBe(
      false,
    )
    expect(
      evaluate(denyOn({ action: ['create', 'update'] }), [change({ action: 'update' })]).allowed,
    ).toBe(false)
    expect(evaluate(denyOn({ action: ['delete'] }), [change({ action: 'update' })]).allowed).toBe(
      true,
    )
  })

  it('matches a resource type exactly and by prefix wildcard', () => {
    expect(evaluate(denyOn({ resourceType: 'mock.database' }), [change()]).allowed).toBe(false)
    expect(evaluate(denyOn({ resourceType: 'mock.*' }), [change()]).allowed).toBe(false)
    expect(evaluate(denyOn({ resourceType: 'stripe.*' }), [change()]).allowed).toBe(true)
    expect(evaluate(denyOn({ resourceType: ['other', 'mock.database'] }), [change()]).allowed).toBe(
      false,
    )
  })

  it('matches on risk', () => {
    expect(
      evaluate(denyOn({ riskIn: ['high', 'critical'] }), [change({ estimatedRisk: 'high' })])
        .allowed,
    ).toBe(false)
    expect(
      evaluate(denyOn({ riskIn: ['critical'] }), [change({ estimatedRisk: 'high' })]).allowed,
    ).toBe(true)
  })

  it('matches on the destructive flag, including explicitly false', () => {
    expect(evaluate(denyOn({ destructive: true }), [change({ destructive: true })]).allowed).toBe(
      false,
    )
    expect(evaluate(denyOn({ destructive: true }), [change({ destructive: false })]).allowed).toBe(
      true,
    )
    expect(evaluate(denyOn({ destructive: false }), [change({ destructive: false })]).allowed).toBe(
      false,
    )
  })

  it('never fires a rule scoped to a different environment', () => {
    expect(evaluate(denyOn({ environment: 'production' }), [change()]).allowed).toBe(false)
    expect(
      evaluate(denyOn({ environment: 'production' }), [change()], { environment: 'local' }).allowed,
    ).toBe(true)
    expect(evaluate(denyOn({ environment: ['staging', 'production'] }), [change()]).allowed).toBe(
      false,
    )
  })

  it('never fires a rule scoped to a different kind', () => {
    expect(evaluate(denyOn({ kind: 'MockWorkspace' }), [change()]).allowed).toBe(false)
    expect(evaluate(denyOn({ kind: 'Other' }), [change()]).allowed).toBe(true)
  })

  it('matches changed field paths against pathPrefix', () => {
    const touchingCurrency = change({
      action: 'update',
      fields: [{ path: 'currency', before: 'eur', after: 'usd', immutable: true }],
    })
    expect(evaluate(denyOn({ pathPrefix: ['currency'] }), [touchingCurrency]).allowed).toBe(false)
    expect(evaluate(denyOn({ pathPrefix: ['plan'] }), [touchingCurrency]).allowed).toBe(true)
  })

  it('matches a rule with no condition against every effective change', () => {
    expect(evaluate(denyOn(undefined), [change()]).allowed).toBe(false)
  })

  it('applies every condition together, not just one of them', () => {
    const bundle = denyOn({ action: 'create', resourceType: 'stripe.price' })
    expect(evaluate(bundle, [change({ action: 'create' })]).allowed).toBe(true)
  })
})

describe('scope of policy evaluation', () => {
  it('ignores noop and blocked changes, which never reach the provider', () => {
    const bundle: PolicyBundle = {
      policies: [policy('p', { id: 'deny-all', effect: 'deny' })],
    }
    const result = evaluate(bundle, [
      change({ id: 'a', action: 'noop' }),
      change({ id: 'b', action: 'blocked' }),
    ])
    expect(result.allowed).toBe(true)
    expect(result.decisions).toEqual([])
  })

  it('still evaluates a plan that mixes real changes with noops', () => {
    const bundle: PolicyBundle = { policies: [policy('p', { id: 'deny-all', effect: 'deny' })] }
    const result = evaluate(bundle, [
      change({ id: 'a', action: 'noop' }),
      change({ id: 'b', action: 'create' }),
    ])
    expect(result.allowed).toBe(false)
    expect(result.decisions[0]?.changeIds).toEqual(['b'])
  })
})

describe('constraints', () => {
  const limited = (constraints: PolicyRule['constraints']): PolicyBundle => ({
    policies: [
      policy('p', {
        id: 'limit',
        when: { action: 'create', resourceType: 'mock.subscription' },
        ...(constraints === undefined ? {} : { constraints }),
        effect: 'deny',
      }),
    ],
  })

  const subscriptions = (count: number): PlanChange[] =>
    Array.from({ length: count }, (_unused, index) =>
      change({ id: `chg_${index}`, resourceType: 'mock.subscription' }),
    )

  it('fires only when the matched count exceeds the limit', () => {
    expect(evaluate(limited({ maxChanges: 2 }), subscriptions(2)).allowed).toBe(true)
    expect(evaluate(limited({ maxChanges: 2 }), subscriptions(3)).allowed).toBe(false)
  })

  it('produces no decision when the constraint is satisfied', () => {
    expect(evaluate(limited({ maxChanges: 10 }), subscriptions(2)).decisions).toEqual([])
  })

  it('counts every effective change for maxTotalChanges', () => {
    const bundle: PolicyBundle = {
      policies: [policy('p', { id: 'total', constraints: { maxTotalChanges: 2 }, effect: 'deny' })],
    }
    expect(evaluate(bundle, subscriptions(2)).allowed).toBe(true)
    expect(evaluate(bundle, subscriptions(3)).allowed).toBe(false)
  })

  it('explains which limit was exceeded', () => {
    const result = evaluate(limited({ maxChanges: 1 }), subscriptions(4))
    expect(result.decisions[0]?.message).toContain('at most 1')
    expect(result.decisions[0]?.message).toContain('plan has 4')
  })

  it('lets an explicit message override the generated one', () => {
    const bundle: PolicyBundle = {
      policies: [
        policy('p', {
          id: 'limit',
          constraints: { maxTotalChanges: 1 },
          effect: 'deny',
          message: 'Too many subscriptions created in one plan',
        }),
      ],
    }
    expect(evaluate(bundle, subscriptions(2)).decisions[0]?.message).toBe(
      'Too many subscriptions created in one plan',
    )
  })

  it('does not fire a constrained rule when nothing matches its condition', () => {
    expect(
      evaluate(limited({ maxChanges: 0 }), [change({ resourceType: 'mock.user' })]).allowed,
    ).toBe(true)
  })
})

describe('determinism', () => {
  const a = policy('alpha', { id: 'r1', effect: 'warn' })
  const b = policy('beta', { id: 'r2', effect: 'warn' })

  it('hashes a bundle independently of load order', () => {
    expect(policyBundleHash({ policies: [a, b] })).toBe(policyBundleHash({ policies: [b, a] }))
  })

  it('changes the hash when a rule changes', () => {
    const modified = policy('alpha', { id: 'r1', effect: 'deny' })
    expect(policyBundleHash({ policies: [modified] })).not.toBe(policyBundleHash({ policies: [a] }))
  })

  it('evaluates policies in a stable order regardless of load order', () => {
    const forward = evaluate({ policies: [a, b] }, [change()])
    const reversed = evaluate({ policies: [b, a] }, [change()])
    expect(forward.decisions).toEqual(reversed.decisions)
    expect(forward.decisions.map((decision) => decision.policyId)).toEqual(['alpha', 'beta'])
  })

  it('sorts policies by name', () => {
    expect(sortedPolicies({ policies: [b, a] }).map((item) => item.metadata.name)).toEqual([
      'alpha',
      'beta',
    ])
  })

  it('returns the same result for repeated evaluation', () => {
    const bundle = { policies: [a, b] }
    expect(evaluate(bundle, [change()])).toEqual(evaluate(bundle, [change()]))
  })

  it('hashes an empty bundle', () => {
    expect(policyBundleHash({ policies: [] })).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
