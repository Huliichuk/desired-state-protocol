import { afterEach, describe, expect, it } from 'vitest'
import { DSPError, containsSensitiveData, type DSPPlan } from '@dsp/protocol'
import {
  AGENT,
  APPROVAL_POLICY,
  BASE_SPEC,
  HUMAN,
  WORKSPACE,
  createHarness,
  document,
  policy,
  type Harness,
} from './harness.js'

const harnesses: Harness[] = []

function harness(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const created = createHarness(options)
  harnesses.push(created)
  return created
}

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.close()
})

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

describe('approval', () => {
  it('refuses to apply a plan that needs approval, then accepts it once approved', async () => {
    const h = harness({ policyBundle: APPROVAL_POLICY })
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })

    expect(plan.approvals.required).toBe(true)
    expect(plan.executable).toBe(true)

    const error = await expectCode(
      h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT }),
      'APPROVAL_REQUIRED',
    )
    expect(error.details?.['approvals']).toBe(0)

    await h.runtime.approve({
      planId: plan.metadata.id,
      approvedBy: 'reviewer',
      reason: 'Reviewed plan',
      planHash: plan.metadata.planHash,
      actor: HUMAN,
    })

    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      actor: AGENT,
    })
    expect(operation.status).toBe('completed')
  })

  it('refuses an approval for a hash that is not the stored plan', async () => {
    const h = harness({ policyBundle: APPROVAL_POLICY })
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })

    const error = await expectCode(
      h.runtime.approve({
        planId: plan.metadata.id,
        approvedBy: 'reviewer',
        reason: 'blind approval',
        planHash: `sha256:${'0'.repeat(64)}`,
        actor: HUMAN,
      }),
      'APPROVAL_INVALID',
    )
    expect(error.details?.['expected']).toBe(plan.metadata.planHash)
  })

  it('makes an approval worthless as soon as the desired state changes', async () => {
    const h = harness({ policyBundle: APPROVAL_POLICY })
    const first = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    await h.runtime.approve({
      planId: first.metadata.id,
      approvedBy: 'reviewer',
      reason: 'Reviewed plan',
      planHash: first.metadata.planHash,
      actor: HUMAN,
    })

    // One extra member: a different desired state, therefore a different plan.
    const widened = document({
      ...BASE_SPEC,
      users: [...BASE_SPEC.users!, { email: 'intruder@example.com', role: 'admin' }],
    })
    const second = await h.runtime.plan({ desiredState: widened, actor: AGENT })

    expect(second.metadata.id).not.toBe(first.metadata.id)
    expect(second.metadata.planHash).not.toBe(first.metadata.planHash)
    await expectCode(
      h.runtime.apply({ planId: second.metadata.id, idempotencyKey: 'k', actor: AGENT }),
      'APPROVAL_REQUIRED',
    )
  })

  it('does not let a re-plan revive an approval from an expired window', async () => {
    const h = harness({ policyBundle: APPROVAL_POLICY })
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    await h.runtime.approve({
      planId: plan.metadata.id,
      approvedBy: 'reviewer',
      reason: 'Reviewed plan',
      planHash: plan.metadata.planHash,
      actor: HUMAN,
    })

    h.advance(16 * 60 * 1000)
    const replanned = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    expect(replanned.metadata.id).toBe(plan.metadata.id)

    await expectCode(
      h.runtime.apply({ planId: replanned.metadata.id, idempotencyKey: 'k', actor: AGENT }),
      'APPROVAL_REQUIRED',
    )
  })

  it('keeps an approval usable while the plan window is still open', async () => {
    const h = harness({ policyBundle: APPROVAL_POLICY })
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    await h.runtime.approve({
      planId: plan.metadata.id,
      approvedBy: 'reviewer',
      reason: 'Reviewed plan',
      planHash: plan.metadata.planHash,
      actor: HUMAN,
    })

    h.advance(60_000)
    await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })

    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      actor: AGENT,
    })
    expect(operation.status).toBe('completed')
  })

  it('requires as many approvals as the policy asked for', async () => {
    const h = harness({
      policyBundle: {
        policies: [
          policy('two-eyes', {
            id: 'two',
            when: { resourceType: 'mock.user' },
            effect: 'requireApproval',
            minApprovals: 2,
          }),
        ],
      },
    })
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })

    await h.runtime.approve({
      planId: plan.metadata.id,
      approvedBy: 'first-reviewer',
      reason: 'ok',
      planHash: plan.metadata.planHash,
      actor: HUMAN,
    })
    await expectCode(
      h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT }),
      'APPROVAL_REQUIRED',
    )

    await h.runtime.approve({
      planId: plan.metadata.id,
      approvedBy: 'second-reviewer',
      reason: 'ok',
      planHash: plan.metadata.planHash,
      actor: HUMAN,
    })
    expect(
      (await h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT }))
        .status,
    ).toBe('completed')
  })

  it('counts one approver once, however often they approve', async () => {
    const h = harness({
      policyBundle: {
        policies: [
          policy('two-eyes', {
            id: 'two',
            when: { resourceType: 'mock.user' },
            effect: 'requireApproval',
            minApprovals: 2,
          }),
        ],
      },
    })
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })

    for (let index = 0; index < 3; index += 1) {
      await h.runtime.approve({
        planId: plan.metadata.id,
        approvedBy: 'same-reviewer',
        reason: `attempt ${index}`,
        planHash: plan.metadata.planHash,
        actor: HUMAN,
      })
    }

    await expectCode(
      h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT }),
      'APPROVAL_REQUIRED',
    )
  })
})

describe('policy enforcement at apply time', () => {
  it('refuses a plan built under a different policy bundle', async () => {
    const first = harness()
    const plan = await first.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    const record = await first.store.getPlan(plan.metadata.id)
    if (record === null) expect.unreachable('the plan must have been stored')

    // A second runtime with different rules, holding the same stored plan.
    const second = harness({
      policyBundle: {
        policies: [policy('other', { id: 'warn-all', effect: 'warn', message: 'watch out' })],
      },
    })
    await second.store.savePlan(record)

    const error = await expectCode(
      second.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT }),
      'POLICY_DENIED',
    )
    expect(error.message).toContain('policy bundle changed')
  })

  it('refuses to enable deletions per request when the runtime forbids them', async () => {
    const h = harness()
    await expectCode(
      h.runtime.plan({
        desiredState: document(BASE_SPEC),
        options: { allowDelete: true },
        actor: AGENT,
      }),
      'DESTRUCTIVE_ACTION_BLOCKED',
    )
  })

  it('refuses a request for a cached current state it does not keep', async () => {
    const h = harness()
    await expectCode(
      h.runtime.plan({
        desiredState: document(BASE_SPEC),
        options: { refreshCurrentState: false },
        actor: AGENT,
      }),
      'NOT_IMPLEMENTED',
    )
  })
})

describe('idempotency', () => {
  it('returns the same operation for a repeated key and does not duplicate resources', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })

    const first = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'same-key',
      actor: AGENT,
    })
    const second = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'same-key',
      actor: AGENT,
    })

    expect(second.id).toBe(first.id)
    expect(h.backend.list(WORKSPACE)).toHaveLength(4)
  })

  it('answers a replayed key from history without re-reading the world', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    await h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT })

    // The world has moved on, which would normally be drift — but a replay must
    // still be answered from the record of what already happened.
    h.backend.injectDrift(WORKSPACE, 'mock.database/main', { region: 'elsewhere' })
    const replay = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      actor: AGENT,
    })
    expect(replay.status).toBe('completed')
  })

  it('treats a different key on an already applied plan as drift', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    await h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'first', actor: AGENT })

    await expectCode(
      h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'second', actor: AGENT }),
      'STATE_DRIFT_DETECTED',
    )
  })

  it('scopes the key to the plan, so the same key can apply a different plan', async () => {
    const h = harness()
    const first = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    await h.runtime.apply({ planId: first.metadata.id, idempotencyKey: 'shared', actor: AGENT })

    const updated = document({
      ...BASE_SPEC,
      databases: [{ ...BASE_SPEC.databases![0]!, sizeGb: 60 }],
    })
    const second = await h.runtime.plan({ desiredState: updated, actor: AGENT })
    const operation = await h.runtime.apply({
      planId: second.metadata.id,
      idempotencyKey: 'shared',
      actor: AGENT,
    })

    expect(operation.status).toBe('completed')
    expect(operation.planId).toBe(second.metadata.id)
  })
})

describe('state drift', () => {
  it('refuses a plan whose world changed after it was built', async () => {
    const h = harness()
    await h.runtime.apply({
      planId: (await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })).metadata
        .id,
      idempotencyKey: 'initial',
      actor: AGENT,
    })

    const updated = document({
      ...BASE_SPEC,
      databases: [{ ...BASE_SPEC.databases![0]!, sizeGb: 80 }],
    })
    const plan = await h.runtime.plan({ desiredState: updated, actor: AGENT })

    // Somebody else edits the same resource between plan and apply.
    h.backend.injectDrift(WORKSPACE, 'mock.database/main', { region: 'somewhere-else' })

    const error = await expectCode(
      h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT }),
      'STATE_DRIFT_DETECTED',
    )
    expect(error.details?.['expectedRevision']).toBe(plan.metadata.currentRevision)
    expect(error.details?.['actualRevision']).not.toBe(plan.metadata.currentRevision)
  })

  it('refuses an If-Match revision that does not describe the current world', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })

    await expectCode(
      h.runtime.apply({
        planId: plan.metadata.id,
        idempotencyKey: 'k',
        ifMatch: 'sha256:' + 'f'.repeat(64),
        actor: AGENT,
      }),
      'STATE_DRIFT_DETECTED',
    )
  })

  it('accepts a matching If-Match revision', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })

    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      ifMatch: plan.metadata.currentRevision ?? 'empty',
      actor: AGENT,
    })
    expect(operation.status).toBe('completed')
  })

  it('lets a fresh plan proceed after drift is acknowledged', async () => {
    const h = harness()
    await h.runtime.apply({
      planId: (await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })).metadata
        .id,
      idempotencyKey: 'initial',
      actor: AGENT,
    })
    h.backend.injectDrift(WORKSPACE, 'mock.database/main', { region: 'drifted' })

    const fresh = await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })
    expect(fresh.summary.update).toBe(1)

    const operation = await h.runtime.apply({
      planId: fresh.metadata.id,
      idempotencyKey: 'after-drift',
      actor: AGENT,
    })
    expect(operation.status).toBe('completed')
  })
})

describe('destructive changes', () => {
  it('blocks a deletion, leaves the resource in place and reports the shortfall', async () => {
    const h = harness()
    await h.runtime.apply({
      planId: (await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })).metadata
        .id,
      idempotencyKey: 'initial',
      actor: AGENT,
    })

    // The subscription disappears from the document.
    const shrunk = document({ ...BASE_SPEC, subscriptions: [] })
    const plan = await h.runtime.plan({ desiredState: shrunk, actor: AGENT })

    expect(plan.summary.delete).toBe(0)
    expect(plan.summary.blocked).toBe(1)
    const blocked = plan.changes.find((change) => change.action === 'blocked')
    expect(blocked?.blockedBy).toBe('DESTRUCTIVE_ACTION_BLOCKED')

    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      actor: AGENT,
    })

    expect(operation.status).toBe('partially_completed')
    expect(operation.changes.find((change) => change.status === 'blocked')).toBeDefined()
    // The resource the agent wanted gone is still there.
    expect(h.backend.get(WORKSPACE, 'mock.subscription/founder@example.com')).not.toBeNull()
  })

  it('performs a deletion only when the runtime was explicitly configured to allow it', async () => {
    const h = harness({ allowDestructive: true })
    await h.runtime.apply({
      planId: (await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })).metadata
        .id,
      idempotencyKey: 'initial',
      actor: AGENT,
    })

    // `mock.table` is the one mock resource type that declares delete support.
    const shrunk = document({
      ...BASE_SPEC,
      databases: [{ ...BASE_SPEC.databases![0]!, tables: [] }],
    })
    const plan = await h.runtime.plan({
      desiredState: shrunk,
      options: { allowDelete: true },
      actor: AGENT,
    })

    expect(plan.summary.delete).toBe(1)
    const operation = await h.runtime.apply({
      planId: plan.metadata.id,
      idempotencyKey: 'k',
      actor: AGENT,
    })
    expect(operation.status).toBe('completed')
    expect(h.backend.get(WORKSPACE, 'mock.table/main.users')).toBeNull()
  })

  it('still refuses a deletion the resource type does not support, even when allowed', async () => {
    const h = harness({ allowDestructive: true })
    await h.runtime.apply({
      planId: (await h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT })).metadata
        .id,
      idempotencyKey: 'initial',
      actor: AGENT,
    })

    const plan = await h.runtime.plan({
      desiredState: document({ ...BASE_SPEC, subscriptions: [] }),
      options: { allowDelete: true },
      actor: AGENT,
    })

    const blocked = plan.changes.find((change) => change.action === 'blocked')
    expect(blocked?.blockedBy).toBe('UNSUPPORTED_OPERATION')
    expect(plan.summary.delete).toBe(0)
  })

  it('reports the manifest feature flag honestly', async () => {
    expect(harness().runtime.manifest().features.destructiveChanges).toBe(false)
    expect(harness({ allowDestructive: true }).runtime.manifest().features.destructiveChanges).toBe(
      true,
    )
  })
})

describe('document limits', () => {
  it('refuses a document larger than the configured limit', async () => {
    const h = harness({ limits: { maxDocumentBytes: 512 } })
    const bulky = document({
      ...BASE_SPEC,
      users: Array.from({ length: 50 }, (_unused, index) => ({
        email: `user${index}@example.com`,
        role: 'viewer' as const,
        displayName: 'x'.repeat(60),
      })),
    })

    await expectCode(h.runtime.plan({ desiredState: bulky, actor: AGENT }), 'DOCUMENT_TOO_LARGE')
  })

  it('reports an oversized document as invalid rather than throwing from validate', async () => {
    const h = harness({ limits: { maxDocumentBytes: 256 } })
    const result = await h.runtime.validate({
      desiredState: document(BASE_SPEC),
      actor: AGENT,
    })
    expect(result.valid).toBe(false)
    expect(result.errors[0]?.code).toBe('DOCUMENT_TOO_LARGE')
  })

  it('refuses a projection with more resources than the limit allows', async () => {
    const h = harness({ limits: { maxResources: 2 } })
    await expectCode(
      h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT }),
      'TOO_MANY_RESOURCES',
    )
  })

  it('refuses a plan with more changes than the limit allows', async () => {
    const h = harness({ limits: { maxChanges: 2 } })
    await expectCode(
      h.runtime.plan({ desiredState: document(BASE_SPEC), actor: AGENT }),
      'TOO_MANY_CHANGES',
    )
  })
})

describe('validation surface', () => {
  it('reports an unknown kind instead of guessing', async () => {
    const h = harness()
    const result = await h.runtime.validate({
      desiredState: { ...document(BASE_SPEC), kind: 'StripeBillingWorkspace' },
      actor: AGENT,
    })
    expect(result.valid).toBe(false)
    expect(result.errors[0]?.code).toBe('UNKNOWN_KIND')
  })

  it('reports envelope errors without consulting the provider', async () => {
    const h = harness()
    const result = await h.runtime.validate({ desiredState: { nonsense: true }, actor: AGENT })
    expect(result.valid).toBe(false)
    expect(result.errors.map((issue) => issue.path)).toContain('apiVersion')
  })

  it('reports spec errors against the kind schema', async () => {
    const h = harness()
    const result = await h.runtime.validate({
      desiredState: document({
        databases: [{ name: 'Bad Name', engine: 'postgres', region: 'eu' }],
      }),
      actor: AGENT,
    })
    expect(result.valid).toBe(false)
    expect(result.errors[0]?.path).toBe('spec.databases[0].name')
  })

  it('surfaces provider warnings alongside a valid result', async () => {
    const h = harness()
    const result = await h.runtime.validate({
      desiredState: document({
        users: [{ email: 'a@b.c', role: 'admin', apiToken: 'inline-token' }],
      }),
      actor: AGENT,
    })
    expect(result.valid).toBe(true)
    expect(result.warnings[0]?.code).toBe('INLINE_SECRET')
  })

  it('reports a missing secret the document referenced', async () => {
    const h = harness()
    const result = await h.runtime.validate({
      desiredState: document({ credentials: { secretRef: { name: 'absent-secret' } } }),
      actor: AGENT,
    })
    expect(result.valid).toBe(false)
    expect(result.errors[0]?.code).toBe('SECRET_NOT_FOUND')
  })

  it('refuses to plan an invalid document', async () => {
    const h = harness()
    await expectCode(
      h.runtime.plan({
        desiredState: document({
          subscriptions: [
            { user: 'ghost@example.com', plan: 'p', amountCents: 1, currency: 'eur' },
          ],
        }),
        actor: AGENT,
      }),
      'VALIDATION_FAILED',
    )
  })
})

describe('secret handling', () => {
  // Assembled at runtime so no credential-shaped literal sits in the repository.
  const TOKEN = ['sk', 'test', 'leakCanary1234567890abcd'].join('_')

  async function appliedWithToken(): Promise<{ h: Harness; plan: DSPPlan }> {
    const h = harness()
    const desiredState = document({
      users: [{ email: 'founder@example.com', role: 'admin', apiToken: TOKEN }],
    })
    const plan = await h.runtime.plan({ desiredState, actor: AGENT })
    await h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT })
    return { h, plan }
  }

  it('never returns a sensitive attribute value through the runtime API', async () => {
    const { h, plan } = await appliedWithToken()
    const desiredState = document({
      users: [{ email: 'founder@example.com', role: 'admin', apiToken: TOKEN }],
    })

    const surfaces: Array<[string, unknown]> = [
      ['plan', plan],
      ['stored plan', await h.runtime.getPlan(plan.metadata.id)],
      ['inspect', await h.runtime.inspect({ desiredState, actor: AGENT })],
      [
        'operation',
        await h.runtime.getOperation((await h.store.listOperations(plan.metadata.id))[0]!.id),
      ],
      ['audit', await h.runtime.audit()],
    ]

    for (const [name, value] of surfaces) {
      expect(JSON.stringify(value), name).not.toContain(TOKEN)
      expect(containsSensitiveData(value), name).toBe(false)
    }
  })

  it('still applies the real value, because redaction happens at the boundary', async () => {
    const { h } = await appliedWithToken()
    expect(h.backend.get(WORKSPACE, 'mock.user/founder@example.com')?.attributes['apiToken']).toBe(
      TOKEN,
    )
  })

  it('redacts the value but keeps the field visible, so the diff is still readable', async () => {
    const { plan } = await appliedWithToken()
    const change = plan.changes.find((item) => item.resourceType === 'mock.user')
    expect((change?.after as Record<string, unknown>)['apiToken']).toBe('[REDACTED]')
    expect((change?.after as Record<string, unknown>)['email']).toBe('founder@example.com')
  })

  it('leaves a resolved credential out of the audit log', async () => {
    const h = harness()
    const desiredState = document({
      credentials: { secretRef: { name: 'mock-api' } },
      databases: [{ name: 'main', engine: 'postgres', region: 'eu' }],
    })
    const plan = await h.runtime.plan({ desiredState, actor: AGENT })
    await h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'k', actor: AGENT })

    const events = await h.runtime.audit()
    expect(JSON.stringify(events)).not.toContain('mock-api-value')
  })
})
