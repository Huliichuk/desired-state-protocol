import { describe, expect, it } from 'vitest'
import {
  DSP_API_VERSION,
  type ChangeAction,
  type DSPPlan,
  type OperationRecord,
  type PlanChange,
} from '@dsp/protocol'
import type { ChangeExecutionResult } from '@dsp/protocol'
import { silentLogger, type DSPProvider, type ProviderExecutionContext } from '@dsp/provider-sdk'
import { executePlan } from '@dsp/execution-engine'

/**
 * Direct tests for the executor.
 *
 * It had none: it was only exercised through the runtime with the reference
 * provider, whose scenarios happened never to add a resource under a parent that
 * already existed. That is how the dependency bug below survived.
 */

const HASH = `sha256:${'0'.repeat(64)}`

function change(overrides: Partial<PlanChange> & { id: string }): PlanChange {
  return {
    resourceType: 'test.resource',
    resourceKey: `test.resource/${overrides.id}`,
    action: 'create' as ChangeAction,
    fields: [],
    reason: 'test',
    reversible: false,
    destructive: false,
    dependencies: [],
    estimatedRisk: 'low',
    ...overrides,
  }
}

function plan(changes: PlanChange[]): DSPPlan {
  return {
    apiVersion: DSP_API_VERSION,
    kind: 'Plan',
    metadata: {
      id: `plan_${'a'.repeat(24)}`,
      createdAt: '2026-07-30T00:00:00.000Z',
      expiresAt: '2026-07-30T00:15:00.000Z',
      desiredStateHash: HASH,
      currentStateHash: HASH,
      policyBundleHash: HASH,
      planHash: HASH,
      kind: 'TestKind',
      namespace: 'default',
      resourceName: 'thing',
      provider: 'test',
      currentRevision: null,
    },
    summary: {
      create: changes.filter((item) => item.action === 'create').length,
      update: 0,
      delete: 0,
      replace: 0,
      noop: changes.filter((item) => item.action === 'noop').length,
      blocked: changes.filter((item) => item.action === 'blocked').length,
      risk: 'low',
      riskScore: 0,
    },
    changes,
    approvals: { required: false, requirements: [] },
    policyEvaluation: { allowed: true, decisions: [], requiredApprovals: [] },
    contract: null,
    executable: true,
  }
}

function operation(changes: PlanChange[]): OperationRecord {
  return {
    id: `op_${'b'.repeat(24)}`,
    tenant: 'local',
    planId: `plan_${'a'.repeat(24)}`,
    planHash: HASH,
    idempotencyKey: 'k',
    status: 'created',
    actor: { type: 'agent', id: 'test' },
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    changes: changes.map((item) => ({
      changeId: item.id,
      resourceType: item.resourceType,
      resourceKey: item.resourceKey,
      action: item.action,
      status: 'pending',
      attempts: 0,
    })),
    verification: null,
    cancellationRequested: false,
    error: null,
  }
}

interface RunOptions {
  changes: PlanChange[]
  applyChange: (
    context: ProviderExecutionContext,
    change: PlanChange,
  ) => Promise<ChangeExecutionResult>
  maxAttempts?: number
}

async function run(options: RunOptions): Promise<OperationRecord> {
  const provider = {
    name: 'test',
    version: '0.0.0',
    kinds: [],
    resourceTypes: [],
    requiredSecrets: () => [],
    validate: async () => ({ valid: true, errors: [], warnings: [] }),
    inspect: async () => ({
      resourceType: 'TestKind',
      resourceId: 'default/thing',
      observedAt: '2026-07-30T00:00:00.000Z',
      state: null,
    }),
    normalizeDesired: async () => ({ resources: [] }),
    normalizeCurrent: async () => ({ resources: [] }),
    applyChange: options.applyChange,
  } as unknown as DSPProvider

  return await executePlan({
    plan: plan(options.changes),
    operation: operation(options.changes),
    provider,
    logger: silentLogger,
    createContext: ({ change: target, attempt, signal }) =>
      ({
        environment: 'test',
        namespace: 'default',
        logger: silentLogger,
        secrets: {
          resolve: async () => {
            throw new Error('no secrets in this test')
          },
        },
        signal,
        limits: {
          maxDocumentBytes: 1000,
          maxDocumentDepth: 10,
          maxResources: 10,
          maxChanges: 10,
          planTtlSeconds: 900,
        },
        now: () => new Date('2026-07-30T00:00:00.000Z'),
        operationId: `op_${'b'.repeat(24)}`,
        idempotencyKey: 'k',
        attempt,
        desired: {
          apiVersion: DSP_API_VERSION,
          kind: 'TestKind',
          metadata: { name: 'thing' },
          spec: {},
        },
        change: target,
      }) as unknown as ProviderExecutionContext,
    onProgress: async () => undefined,
    isCancellationRequested: async () => false,
    timeoutMs: 1000,
    retry:
      options.maxAttempts === undefined
        ? { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, factor: 2 }
        : { maxAttempts: options.maxAttempts, initialDelayMs: 1, maxDelayMs: 2, factor: 2 },
    now: () => new Date('2026-07-30T00:00:00.000Z'),
    sleep: async () => undefined,
  })
}

const byId = (record: OperationRecord, id: string) =>
  record.changes.find((item) => item.changeId === id)

describe('a dependency that is already in place', () => {
  it('does not block a new resource under a parent that already exists', async () => {
    // Found by the Stripe provider: adding a price to an existing product. The
    // parent plans as a noop, and requiring `succeeded` skipped the child.
    const applied: string[] = []
    const record = await run({
      changes: [
        change({ id: 'chg_parent', action: 'noop', resourceKey: 'test.resource/parent' }),
        change({
          id: 'chg_child',
          resourceKey: 'test.resource/child',
          dependencies: ['chg_parent'],
        }),
      ],
      applyChange: async (_context, target) => {
        applied.push(target.id)
        return {}
      },
    })

    expect(applied).toEqual(['chg_child'])
    expect(byId(record, 'chg_parent')?.status).toBe('skipped')
    expect(byId(record, 'chg_child')?.status).toBe('succeeded')
    expect(record.status).toBe('completed')
  })

  it('still refuses a child whose parent was blocked', async () => {
    const applied: string[] = []
    const record = await run({
      changes: [
        change({ id: 'chg_parent', action: 'blocked', resourceKey: 'test.resource/parent' }),
        change({ id: 'chg_child', dependencies: ['chg_parent'] }),
      ],
      applyChange: async (_context, target) => {
        applied.push(target.id)
        return {}
      },
    })

    expect(applied).toEqual([])
    expect(byId(record, 'chg_child')?.status).toBe('skipped')
    expect(byId(record, 'chg_child')?.error?.message).toContain('not satisfied')
  })

  it('still refuses a child whose parent failed', async () => {
    const record = await run({
      changes: [
        change({ id: 'chg_parent', resourceKey: 'test.resource/parent' }),
        change({ id: 'chg_child', dependencies: ['chg_parent'] }),
      ],
      applyChange: async (_context, target) => {
        if (target.id === 'chg_parent') throw new Error('parent failed')
        return {}
      },
      maxAttempts: 1,
    })

    expect(byId(record, 'chg_parent')?.status).toBe('failed')
    expect(byId(record, 'chg_child')?.status).toBe('skipped')
    // Nothing succeeded, so the operation failed outright rather than partially.
    expect(record.status).toBe('failed')
  })

  it('refuses a child whose parent was itself skipped for an unmet dependency', async () => {
    const record = await run({
      changes: [
        change({ id: 'chg_root', action: 'blocked', resourceKey: 'test.resource/root' }),
        change({ id: 'chg_mid', dependencies: ['chg_root'] }),
        change({ id: 'chg_leaf', dependencies: ['chg_mid'] }),
      ],
      applyChange: async () => ({}),
    })

    // The skip has to be transitive, or a leaf would be applied under a parent that
    // was never created.
    expect(byId(record, 'chg_leaf')?.status).toBe('skipped')
  })

  it('treats a dependency that is not in the plan as unsatisfied', async () => {
    const record = await run({
      changes: [change({ id: 'chg_child', dependencies: ['chg_absent'] })],
      applyChange: async () => ({}),
    })
    expect(byId(record, 'chg_child')?.status).toBe('skipped')
  })
})

describe('what the executor will not do', () => {
  it('never calls the provider for a noop or a blocked change', async () => {
    const applied: string[] = []
    await run({
      changes: [
        change({ id: 'chg_noop', action: 'noop' }),
        change({ id: 'chg_blocked', action: 'blocked' }),
      ],
      applyChange: async (_context, target) => {
        applied.push(target.id)
        return {}
      },
    })
    expect(applied).toEqual([])
  })

  it('executes changes in plan order', async () => {
    const applied: string[] = []
    await run({
      changes: ['a', 'b', 'c'].map((suffix) => change({ id: `chg_${suffix}` })),
      applyChange: async (_context, target) => {
        applied.push(target.id)
        return {}
      },
    })
    expect(applied).toEqual(['chg_a', 'chg_b', 'chg_c'])
  })
})
