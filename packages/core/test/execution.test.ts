import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DSPError } from '@dsp/protocol'
import { DEFAULT_RETRY } from '@dsp/execution-engine'
import { openDatabase } from '@dsp/core'
import { AGENT, BASE_SPEC, WORKSPACE, createHarness, document, type Harness } from './harness.js'
import type { MockWorkspaceSpec } from '@dsp/provider-mock'

const harnesses: Harness[] = []

function harness(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const created = createHarness(options)
  harnesses.push(created)
  return created
}

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.close()
})

const FAILING_KEY = 'mock.subscription/founder@example.com'

function withSimulation(simulate: MockWorkspaceSpec['simulate']) {
  return document({ ...BASE_SPEC, ...(simulate === undefined ? {} : { simulate }) })
}

async function applyOnce(h: Harness, desiredState: ReturnType<typeof document>) {
  const plan = await h.runtime.plan({ desiredState, actor: AGENT })
  return h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT })
}

describe('retry', () => {
  it('retries a retryable provider failure and records the attempt count', async () => {
    const h = harness({ retry: DEFAULT_RETRY })
    const operation = await applyOnce(
      h,
      withSimulation({ failResourceKey: FAILING_KEY, failureMode: 'retryable', failAttempts: 1 }),
    )

    const change = operation.changes.find((item) => item.resourceKey === FAILING_KEY)
    expect(change?.status).toBe('succeeded')
    expect(change?.attempts).toBe(2)
    expect(operation.status).toBe('completed')
  })

  it('gives up after the configured number of attempts', async () => {
    const h = harness({ retry: { ...DEFAULT_RETRY, maxAttempts: 2 } })
    const operation = await applyOnce(
      h,
      withSimulation({ failResourceKey: FAILING_KEY, failureMode: 'retryable' }),
    )

    const change = operation.changes.find((item) => item.resourceKey === FAILING_KEY)
    expect(change?.status).toBe('failed')
    expect(change?.attempts).toBe(2)
    expect(change?.error?.code).toBe('PROVIDER_ERROR')
    expect(change?.error?.retryable).toBe(true)
  })

  it('does not retry a permanent failure', async () => {
    const h = harness({ retry: DEFAULT_RETRY })
    const operation = await applyOnce(
      h,
      withSimulation({ failResourceKey: FAILING_KEY, failureMode: 'permanent' }),
    )

    const change = operation.changes.find((item) => item.resourceKey === FAILING_KEY)
    expect(change?.status).toBe('failed')
    expect(change?.attempts).toBe(1)
    expect(change?.error?.retryable).toBe(false)
  })
})

describe('timeouts', () => {
  it('reports a provider that never returns as a timeout', async () => {
    const h = harness({ limits: { providerCallTimeoutMs: 60 } })
    const operation = await applyOnce(
      h,
      withSimulation({ failResourceKey: FAILING_KEY, failureMode: 'timeout' }),
    )

    const change = operation.changes.find((item) => item.resourceKey === FAILING_KEY)
    expect(change?.status).toBe('failed')
    expect(change?.error?.code).toBe('PROVIDER_TIMEOUT')
    expect(change?.error?.retryable).toBe(true)
  })
})

describe('partial failure', () => {
  it('keeps the work that succeeded and does not roll it back', async () => {
    const h = harness()
    const operation = await applyOnce(
      h,
      withSimulation({ failResourceKey: FAILING_KEY, failureMode: 'permanent' }),
    )

    expect(operation.status).toBe('partially_completed')
    const succeeded = operation.changes.filter((change) => change.status === 'succeeded')
    expect(succeeded.length).toBe(3)

    // The database, table and member exist; only the subscription is missing.
    expect(h.backend.list(WORKSPACE)).toHaveLength(3)
    expect(h.backend.get(WORKSPACE, FAILING_KEY)).toBeNull()
  })

  it('skips a change whose dependency failed, rather than attempting it', async () => {
    const h = harness()
    const operation = await applyOnce(
      h,
      withSimulation({ failResourceKey: 'mock.database/main', failureMode: 'permanent' }),
    )

    const table = operation.changes.find((change) => change.resourceKey === 'mock.table/main.users')
    expect(table?.status).toBe('skipped')
    expect(table?.attempts).toBe(0)
    expect(table?.error?.message).toContain('dependencies did not succeed')
    expect(h.backend.get(WORKSPACE, 'mock.table/main.users')).toBeNull()
  })

  it('reports a failed plan when nothing at all succeeded', async () => {
    const h = harness()
    const desiredState = document({
      databases: [{ name: 'main', engine: 'postgres', region: 'eu' }],
      simulate: { failResourceKey: 'mock.database/main', failureMode: 'permanent' },
    })
    const operation = await applyOnce(h, desiredState)

    expect(operation.status).toBe('failed')
    expect(operation.verification?.status).not.toBe('satisfied')
  })

  it('re-planning after a partial failure asks only for what is still missing', async () => {
    const h = harness()
    await applyOnce(h, withSimulation({ failResourceKey: FAILING_KEY, failureMode: 'permanent' }))

    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    expect(plan.summary).toMatchObject({ create: 1, noop: 3 })
  })
})

describe('verification', () => {
  it('notices when the provider state does not match what was asked for', async () => {
    const h = harness()
    const operation = await applyOnce(h, withSimulation({ driftResourceKey: 'mock.database/main' }))

    expect(operation.verification?.status).toBe('partially_satisfied')
    expect(operation.verification?.satisfaction).toBeLessThan(1)
    expect(operation.status).toBe('verification_failed')

    const mismatch = operation.verification?.unmatched.find((item) =>
      item.path.includes('mock.database/main.region'),
    )
    expect(mismatch?.actual).toBe('drifted-region')
  })

  it('can be re-run on demand and reflects the world at that moment', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      actor: AGENT,
    })
    expect(operation.verification?.status).toBe('satisfied')

    h.backend.injectDrift(WORKSPACE, 'mock.database/main', { region: 'moved' })
    const reverified = await h.runtime.verify(operation.id, AGENT)
    expect(reverified.status).toBe('partially_satisfied')
  })

  it('lists the matched paths so a reviewer can see what was confirmed', async () => {
    const h = harness()
    const operation = await applyOnce(h, document(BASE_SPEC))
    expect(operation.verification?.matched.length).toBeGreaterThan(10)
    expect(operation.verification?.matched).toContain('mock.database/main.engine')
    expect(operation.verification?.unmatched).toEqual([])
  })

  it('treats a blocked change as an unmet desired state', async () => {
    const h = harness()
    await applyOnce(h, document(BASE_SPEC))

    const plan = await h.runtime.plan({
      desiredState: document({ ...BASE_SPEC, subscriptions: [] }),
      actor: AGENT,
    })
    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'blocked-apply',
      actor: AGENT,
    })

    // The subscription is still there, but it is no longer desired, and DSP only
    // verifies what the document asked for — so the rest is satisfied.
    expect(operation.status).toBe('partially_completed')
    expect(operation.verification?.status).toBe('satisfied')
  })
})

describe('operations', () => {
  it('reports an unknown operation', async () => {
    const h = harness()
    try {
      await h.runtime.getOperation('op_' + '0'.repeat(24))
      expect.unreachable('an unknown operation must be reported')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('OPERATION_NOT_FOUND')
    }
  })

  it('cancels an operation that has not started', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    await h.store.saveOperation({
      id: 'op_' + '1'.repeat(24),
      tenant: 'local',
      planId: plan.metadata.id,
      planHash: plan.metadata.planHash,
      idempotencyKey: 'pending',
      status: 'created',
      actor: AGENT,
      createdAt: h.now().toISOString(),
      updatedAt: h.now().toISOString(),
      changes: [],
      verification: null,
      cancellationRequested: false,
      error: null,
    })

    const cancelled = await h.runtime.cancel('op_' + '1'.repeat(24), AGENT)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancellationRequested).toBe(true)
  })

  it('refuses to cancel an operation that already finished', async () => {
    const h = harness()
    const operation = await applyOnce(h, document(BASE_SPEC))

    try {
      await h.runtime.cancel(operation.id, AGENT)
      expect.unreachable('a finished operation must not be cancellable')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('CANCELLED')
      expect(error.details?.['status']).toBe('completed')
    }
  })
})

describe('audit trail', () => {
  it('records the lifecycle in order and keeps the chain verifiable', async () => {
    const h = harness()
    const desiredState = document(BASE_SPEC)
    await h.runtime.validate({ desiredState, actor: AGENT })
    const plan = await h.runtime.plan({ desiredState, actor: AGENT })
    await h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT })

    const actions = (await h.runtime.audit()).map((event) => event.action)
    expect(actions[0]).toBe('document.validate')
    expect(actions).toContain('plan.create')
    expect(actions).toContain('plan.apply')
    expect(actions).toContain('change.apply')
    expect(actions).toContain('operation.verify')

    expect(await h.runtime.verifyAuditChain()).toMatchObject({ valid: true })
  })

  it('attributes every event to the actor that caused it', async () => {
    const h = harness()
    await h.runtime.validate({ desiredState: document(BASE_SPEC), actor: AGENT })
    const [event] = await h.runtime.audit()
    expect(event?.actor).toEqual(AGENT)
  })

  it('records a blocked outcome when policy refuses a plan', async () => {
    const h = harness({
      policyBundle: {
        policies: [
          {
            apiVersion: 'dsp.dev/v1alpha1',
            kind: 'Policy',
            metadata: { name: 'deny' },
            spec: { rules: [{ id: 'deny-all', effect: 'deny', message: 'no' }] },
          },
        ],
      },
    })
    await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })

    const event = (await h.runtime.audit()).find((item) => item.action === 'plan.create')
    expect(event?.outcome).toBe('blocked')
  })

  it('detects an audit row edited directly in the database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsp-audit-'))
    const h = harness({ storePath: join(directory, 'runtime.sqlite') })

    try {
      const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
      await h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT })
      expect(await h.runtime.verifyAuditChain()).toMatchObject({ valid: true })

      // Somebody with database access rewrites history to hide an apply.
      const events = await h.runtime.audit()
      const target = events.find((event) => event.action === 'plan.apply')
      if (target === undefined) expect.unreachable('the apply must have been recorded')

      const direct = openDatabase(join(directory, 'runtime.sqlite'))
      try {
        direct
          .prepare('UPDATE audit_events SET record = ? WHERE id = ?')
          .run(JSON.stringify({ ...target, outcome: 'blocked' }), target.id)
      } finally {
        direct.close()
      }

      const verification = await h.runtime.verifyAuditChain()
      expect(verification.valid).toBe(false)
      expect(verification.brokenAt?.sequence).toBe(target.sequence)
      expect(verification.brokenAt?.reason).toContain('eventHash does not match')
    } finally {
      h.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads a single audit event back and reports an unknown one', async () => {
    const h = harness()
    await h.runtime.validate({ desiredState: document(BASE_SPEC), actor: AGENT })
    const [event] = await h.runtime.audit()
    if (event === undefined) expect.unreachable('there must be an audit event')
    else expect((await h.runtime.auditEvent(event.id)).id).toBe(event.id)

    await expect(h.runtime.auditEvent('evt_missing')).rejects.toThrow(DSPError)
  })

  it('filters audit events by plan and operation', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      actor: AGENT,
    })

    const forPlan = await h.runtime.audit({ planId: plan.metadata.id })
    expect(forPlan.every((event) => event.planId === plan.metadata.id)).toBe(true)

    const forOperation = await h.runtime.audit({ operationId: operation.id })
    expect(forOperation.length).toBeGreaterThan(0)
    expect(forOperation.every((event) => event.operationId === operation.id)).toBe(true)
  })
})

describe('discovery surface', () => {
  it('publishes resource types and kinds rather than tools', async () => {
    const h = harness()
    expect(h.runtime.listResourceTypes().map((type) => type.name)).toEqual([
      'mock.database',
      'mock.subscription',
      'mock.table',
      'mock.user',
    ])
    expect(h.runtime.listKinds().map((kind) => kind.kind)).toEqual(['MockWorkspace'])
  })

  it('reports an unknown resource type and an unknown kind', async () => {
    const h = harness()
    expect(() => h.runtime.getResourceType('stripe.product')).toThrow(DSPError)
    expect(() => h.runtime.getKind('StripeBillingWorkspace')).toThrow(DSPError)
  })

  it('describes its own limits and features in the manifest', async () => {
    const manifest = harness().runtime.manifest()
    expect(manifest.protocol).toBe('dsp')
    expect(manifest.features.planBeforeApply).toBe(true)
    expect(manifest.features.driftDetection).toBe(true)
    expect(manifest.limits.planTtlSeconds).toBeGreaterThan(0)
  })
})
