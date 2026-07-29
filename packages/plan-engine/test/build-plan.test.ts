import { describe, expect, it } from 'vitest'
import { DSPError, type PlanChange, type PolicyEvaluationResult } from '@dsp/protocol'
import { assertRefinement, buildPlan, computePlanHash, isPlanExpired } from '@dsp/plan-engine'
import {
  ALLOW_ALL,
  DB_TYPE,
  SUB_TYPE,
  TABLE_TYPE,
  document,
  planInput,
  projection,
  resource,
} from './fixtures.js'

const desired = projection(
  resource(DB_TYPE, 'db/main', { name: 'main', engine: 'postgres' }),
  resource(TABLE_TYPE, 'tbl/users', { name: 'users' }, ['db/main']),
)

describe('buildPlan — determinism', () => {
  it('produces an identical plan hash and id for identical inputs', async () => {
    const first = await buildPlan(planInput({ desiredProjection: desired }))
    const second = await buildPlan(planInput({ desiredProjection: desired }))

    expect(first.metadata.planHash).toBe(second.metadata.planHash)
    expect(first.metadata.id).toBe(second.metadata.id)
    expect(first.changes).toEqual(second.changes)
  })

  it('does not let the clock influence the plan hash', async () => {
    const early = await buildPlan(
      planInput({ desiredProjection: desired, now: new Date('2026-01-01T00:00:00.000Z') }),
    )
    const late = await buildPlan(
      planInput({ desiredProjection: desired, now: new Date('2026-12-31T23:59:59.000Z') }),
    )

    expect(early.metadata.planHash).toBe(late.metadata.planHash)
    expect(early.metadata.createdAt).not.toBe(late.metadata.createdAt)
  })

  it('derives the plan id from the plan hash', async () => {
    const plan = await buildPlan(planInput({ desiredProjection: desired }))
    expect(plan.metadata.id).toBe(`plan_${plan.metadata.planHash.slice(7, 31)}`)
  })

  it('changes the hash when the desired state changes', async () => {
    const base = await buildPlan(planInput({ desiredProjection: desired }))
    const changed = await buildPlan(
      planInput({
        desiredProjection: projection(
          resource(DB_TYPE, 'db/main', { name: 'main', engine: 'postgres', sizeGb: 10 }),
          resource(TABLE_TYPE, 'tbl/users', { name: 'users' }, ['db/main']),
        ),
      }),
    )
    expect(changed.metadata.planHash).not.toBe(base.metadata.planHash)
  })

  it('changes the hash when the policy bundle changes', async () => {
    const base = await buildPlan(planInput({ desiredProjection: desired }))
    const other = await buildPlan(
      planInput({ desiredProjection: desired, policyBundleHash: `sha256:${'b'.repeat(64)}` }),
    )
    expect(other.metadata.planHash).not.toBe(base.metadata.planHash)
  })

  it('changes the hash when the environment changes the risk', async () => {
    const local = await buildPlan(planInput({ desiredProjection: desired }))
    const production = await buildPlan(
      planInput({ desiredProjection: desired, environment: 'production' }),
    )
    expect(production.metadata.planHash).not.toBe(local.metadata.planHash)
  })

  it('records the hashes of both sides of the diff', async () => {
    const plan = await buildPlan(planInput({ desiredProjection: desired }))
    expect(plan.metadata.desiredStateHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(plan.metadata.currentStateHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('buildPlan — integrity', () => {
  it('recomputes to the same hash it published', async () => {
    const plan = await buildPlan(planInput({ desiredProjection: desired }))
    expect(computePlanHash(plan)).toBe(plan.metadata.planHash)
  })

  it('detects tampering with a change', async () => {
    const plan = (await buildPlan(planInput({ desiredProjection: desired }))) as {
      changes: PlanChange[]
      metadata: { planHash: string }
    }
    const first = plan.changes[0]
    if (first === undefined) expect.unreachable('the plan must contain changes')
    else first.after = { name: 'main', engine: 'postgres', sizeGb: 9999 }

    expect(computePlanHash(plan as never)).not.toBe(plan.metadata.planHash)
  })

  it('detects tampering with the summary', async () => {
    const plan = await buildPlan(planInput({ desiredProjection: desired }))
    const tampered = { ...plan, summary: { ...plan.summary, create: 99 } }
    expect(computePlanHash(tampered)).not.toBe(plan.metadata.planHash)
  })

  it('detects tampering with the executable flag', async () => {
    const plan = await buildPlan(planInput({ desiredProjection: desired }))
    expect(computePlanHash({ ...plan, executable: !plan.executable })).not.toBe(
      plan.metadata.planHash,
    )
  })
})

describe('buildPlan — content', () => {
  it('orders changes so dependencies come first', async () => {
    const plan = await buildPlan(planInput({ desiredProjection: desired }))
    const keys = plan.changes.map((change) => change.resourceKey)
    expect(keys.indexOf('db/main')).toBeLessThan(keys.indexOf('tbl/users'))
  })

  it('summarizes the actions it produced', async () => {
    const plan = await buildPlan(
      planInput({
        desiredProjection: projection(
          resource(DB_TYPE, 'db/keep', { name: 'keep' }),
          resource(DB_TYPE, 'db/new', { name: 'new' }),
        ),
        currentProjection: projection(
          resource(DB_TYPE, 'db/keep', { name: 'keep' }),
          resource(DB_TYPE, 'db/gone', { name: 'gone' }),
        ),
      }),
    )

    expect(plan.summary).toMatchObject({ create: 1, noop: 1, blocked: 1, delete: 0, update: 0 })
    expect(plan.summary.create + plan.summary.noop + plan.summary.blocked).toBe(plan.changes.length)
  })

  it('carries the document identity into the plan metadata', async () => {
    const plan = await buildPlan(
      planInput({
        desired: { ...document(), metadata: { name: 'demo', namespace: 'team-a' } },
        desiredProjection: desired,
      }),
    )
    expect(plan.metadata).toMatchObject({
      kind: 'TestWorkspace',
      namespace: 'team-a',
      resourceName: 'demo',
      provider: 'test',
    })
  })

  it('defaults the namespace when the document omits it', async () => {
    const plan = await buildPlan(planInput({ desiredProjection: desired }))
    expect(plan.metadata.namespace).toBe('default')
  })

  it('sets expiry from the plan TTL and reports expiry against a clock', async () => {
    const now = new Date('2026-07-29T18:00:00.000Z')
    const plan = await buildPlan(planInput({ desiredProjection: desired, now }))

    expect(plan.metadata.expiresAt).toBe('2026-07-29T18:15:00.000Z')
    expect(isPlanExpired(plan, now)).toBe(false)
    expect(isPlanExpired(plan, new Date('2026-07-29T18:14:59.000Z'))).toBe(false)
    expect(isPlanExpired(plan, new Date('2026-07-29T18:15:00.000Z'))).toBe(true)
  })

  it('rejects a plan whose changes exceed the configured limit', async () => {
    const many = projection(
      ...Array.from({ length: 20 }, (_unused, index) =>
        resource(DB_TYPE, `db/${index}`, { name: String(index) }),
      ),
    )
    const input = planInput({ desiredProjection: many })
    await expect(
      buildPlan({ ...input, limits: { ...input.limits, maxChanges: 5 } }),
    ).rejects.toThrow(/TOO_MANY_CHANGES|limit is 5/)
  })
})

describe('buildPlan — policy integration', () => {
  it('is not executable when policy denies', async () => {
    const denied: PolicyEvaluationResult = {
      allowed: false,
      decisions: [
        {
          policyId: 'p',
          ruleId: 'block-delete',
          effect: 'deny',
          changeIds: [],
          message: 'nope',
        },
      ],
      requiredApprovals: [],
    }
    const plan = await buildPlan(
      planInput({ desiredProjection: desired, evaluatePolicies: () => denied }),
    )
    expect(plan.executable).toBe(false)
    expect(plan.policyEvaluation.decisions[0]?.effect).toBe('deny')
  })

  it('requires approval when policy asks for one', async () => {
    const plan = await buildPlan(
      planInput({
        desiredProjection: desired,
        evaluatePolicies: () => ({
          allowed: true,
          decisions: [],
          requiredApprovals: [{ id: 'apr_1', reason: 'risky', minApprovals: 2, risk: 'high' }],
        }),
      }),
    )
    expect(plan.approvals.required).toBe(true)
    expect(plan.approvals.requirements[0]?.minApprovals).toBe(2)
    expect(plan.executable).toBe(true)
  })

  it('needs no approval when nothing requires one', async () => {
    const plan = await buildPlan(planInput({ desiredProjection: desired }))
    expect(plan.approvals).toEqual({ required: false, requirements: [] })
  })

  it('passes the scored changes to the policy engine', async () => {
    let seen: PlanChange[] = []
    await buildPlan(
      planInput({
        desiredProjection: projection(resource(SUB_TYPE, 'sub/a', { user: 'a' })),
        environment: 'production',
        evaluatePolicies: ({ changes, risk }) => {
          seen = changes
          expect(risk.level).not.toBe('low')
          return ALLOW_ALL
        },
      }),
    )
    expect(seen[0]?.estimatedRisk).not.toBe('low')
  })
})

describe('buildPlan — provider refinement', () => {
  it('applies an annotation-only refinement before risk is scored', async () => {
    const plan = await buildPlan(
      planInput({
        desiredProjection: projection(
          resource(DB_TYPE, 'db/main', { name: 'main', engine: 'postgres' }),
        ),
        refineChanges: async (changes) =>
          changes.map((change) => ({ ...change, destructive: true, reason: 'provider says so' })),
      }),
    )

    expect(plan.changes[0]?.destructive).toBe(true)
    expect(plan.changes[0]?.reason).toBe('provider says so')
  })

  it('rejects a refinement that changes what would be executed', async () => {
    const cases: Array<[string, (changes: PlanChange[]) => PlanChange[]]> = [
      ['drops a change', (changes) => changes.slice(1)],
      [
        'adds a change',
        (changes) => [...changes, { ...(changes[0] as PlanChange), id: 'chg_extra' }],
      ],
      ['changes an action', (changes) => changes.map((c) => ({ ...c, action: 'delete' as const }))],
      ['changes the id', (changes) => changes.map((c) => ({ ...c, id: 'chg_other' }))],
      [
        'changes the target',
        (changes) => changes.map((c) => ({ ...c, resourceKey: 'db/elsewhere' })),
      ],
      [
        'changes the resource type',
        (changes) => changes.map((c) => ({ ...c, resourceType: 'other.type' })),
      ],
      [
        'changes dependencies',
        (changes) => changes.map((c) => ({ ...c, dependencies: ['chg_injected'] })),
      ],
      [
        'changes the target attributes',
        (changes) => changes.map((c) => ({ ...c, after: { name: 'hijacked' } })),
      ],
    ]

    for (const [name, refine] of cases) {
      const promise = buildPlan(
        planInput({
          desiredProjection: projection(resource(DB_TYPE, 'db/main', { name: 'main' })),
          refineChanges: async (changes) => refine(changes),
        }),
      )
      await expect(promise, name).rejects.toThrow(DSPError)
    }
  })

  it('accepts a create refinement even though before and after are absent on one side', async () => {
    await expect(
      buildPlan(
        planInput({
          desiredProjection: projection(resource(DB_TYPE, 'db/main', { name: 'main' })),
          refineChanges: async (changes) => changes.map((change) => ({ ...change })),
        }),
      ),
    ).resolves.toBeDefined()
  })

  it('accepts a delete refinement, where after is absent', async () => {
    await expect(
      buildPlan(
        planInput({
          currentProjection: projection(resource(DB_TYPE, 'db/main', { name: 'main' })),
          allowDelete: true,
          refineChanges: async (changes) => changes.map((change) => ({ ...change })),
        }),
      ),
    ).resolves.toBeDefined()
  })
})

describe('assertRefinement', () => {
  const original: PlanChange[] = [
    {
      id: 'chg_1',
      resourceType: DB_TYPE,
      resourceKey: 'db/main',
      action: 'update',
      fields: [],
      reason: 'r',
      reversible: true,
      destructive: false,
      dependencies: [],
      estimatedRisk: 'low',
      before: { a: 1 },
      after: { a: 2 },
    },
  ]

  it('returns the refined changes when only advisory fields differ', () => {
    const refined = assertRefinement(original, [
      { ...(original[0] as PlanChange), reason: 'better reason', destructive: true },
    ])
    expect(refined[0]?.reason).toBe('better reason')
  })

  it('reports the change id it refused', () => {
    try {
      assertRefinement(original, [{ ...(original[0] as PlanChange), action: 'delete' }])
      expect.unreachable('an altered action must be refused')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('PROVIDER_ERROR')
      expect(error.details?.['changeId']).toBe('chg_1')
    }
  })
})
