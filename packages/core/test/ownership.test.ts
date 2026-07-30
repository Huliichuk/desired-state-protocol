import { afterEach, describe, expect, it } from 'vitest'
import { DSPError, ownershipScope, type DesiredStateDocument } from '@dsp/protocol'
import { computePlanHash } from '@dsp/plan-engine'
import type { MockWorkspaceSpec } from '@dsp/provider-mock'
import { AGENT, createHarness, document, type Harness } from './harness.js'

const harnesses: Harness[] = []

function harness(): Harness {
  const created = createHarness()
  harnesses.push(created)
  return created
}

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.close()
})

const DB = (region = 'eu-central-1', sizeGb?: number): MockWorkspaceSpec => ({
  databases: [
    { name: 'main', engine: 'postgres', region, ...(sizeGb === undefined ? {} : { sizeGb }) },
  ],
})

/** The mock scopes its world by namespace and workspace name. */
const scopeFor = (namespace: string, name: string) =>
  ownershipScope({ provider: 'mock', resourceId: `${namespace}/${name}` })

function named(
  spec: MockWorkspaceSpec,
  name: string,
  namespace?: string,
): DesiredStateDocument<MockWorkspaceSpec> {
  const base = document(spec)
  return {
    ...base,
    metadata: { ...base.metadata, name, ...(namespace === undefined ? {} : { namespace }) },
  }
}

async function applyDocument(
  h: Harness,
  desiredState: DesiredStateDocument<MockWorkspaceSpec>,
  idempotencyKey: string,
) {
  const plan = await h.runtime.plan({ desiredState, actor: AGENT })
  const operation = await h.runtime.apply({
    planId: plan.metadata.id,
    idempotencyKey,
    actor: AGENT,
  })
  return { plan, operation }
}

describe('claiming', () => {
  it('claims every declared leaf path, scoped to the world it inspected', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(DB()), actor: AGENT })

    expect(plan.ownership?.owner).toBe('MockWorkspace/default/demo')
    expect(plan.ownership?.claims).toEqual([
      {
        scope: scopeFor('default', 'demo'),
        resourceKey: 'mock.database/main',
        paths: ['engine', 'name', 'region'],
        owner: 'MockWorkspace/default/demo',
      },
    ])
  })

  it('records the claim once the change lands', async () => {
    const h = harness()
    await applyDocument(h, document(DB()), 'a')

    const snapshot = await h.store.ownershipFor(scopeFor('default', 'demo'), ['mock.database/main'])
    expect(snapshot.claims[0]).toMatchObject({
      owner: 'MockWorkspace/default/demo',
      paths: ['engine', 'name', 'region'],
    })
  })

  it('claims nothing before an apply', async () => {
    const h = harness()
    await h.runtime.plan({ desiredState: document(DB()), actor: AGENT })

    const snapshot = await h.store.ownershipFor(scopeFor('default', 'demo'), ['mock.database/main'])
    expect(snapshot.claims).toEqual([])
  })

  it('claims nothing for a change that was blocked', async () => {
    const h = harness()
    await applyDocument(h, document(DB()), 'a')

    // Dropping the resource asks for a deletion, which the mock refuses.
    const { plan } = await applyDocument(h, document({ databases: [] }), 'b')
    expect(plan.changes[0]?.action).toBe('blocked')

    // The document no longer declares the resource, so it released the paths it had.
    const snapshot = await h.store.ownershipFor(scopeFor('default', 'demo'), ['mock.database/main'])
    expect(snapshot.claims).toEqual([])
  })
})

describe('releasing', () => {
  it('reports the release and leaves the value in place', async () => {
    const h = harness()
    await applyDocument(h, document(DB('eu-central-1', 20)), 'a')

    const { plan } = await applyDocument(h, document(DB('eu-central-1')), 'b')

    expect(plan.ownership?.releases).toEqual([
      {
        scope: scopeFor('default', 'demo'),
        resourceKey: 'mock.database/main',
        paths: ['sizeGb'],
        owner: 'MockWorkspace/default/demo',
      },
    ])

    // The value survives. Before ownership existed it vanished, and nothing said so.
    expect(
      h.backend.get({ namespace: 'default', workspace: 'demo' }, 'mock.database/main')?.attributes[
        'sizeGb'
      ],
    ).toBe(20)
  })

  it('stops recording the released path', async () => {
    const h = harness()
    await applyDocument(h, document(DB('eu-central-1', 20)), 'a')
    await applyDocument(h, document(DB('eu-central-1')), 'b')

    const snapshot = await h.store.ownershipFor(scopeFor('default', 'demo'), ['mock.database/main'])
    expect(snapshot.claims[0]?.paths).not.toContain('sizeGb')
  })

  it('releases nothing when the document is unchanged', async () => {
    const h = harness()
    await applyDocument(h, document(DB()), 'a')
    const { plan } = await applyDocument(h, document(DB()), 'b')
    expect(plan.ownership?.releases).toEqual([])
  })
})

describe('conflicts', () => {
  it('blocks a change over a field another document owns, and names the owner', async () => {
    const h = harness()
    await applyDocument(h, named(DB('eu-central-1'), 'shared'), 'a')

    // A second document, same world, same resource, different value.
    const plan = await h.runtime.plan({
      desiredState: named(DB('us-east-1'), 'shared'),
      actor: AGENT,
    })

    // Same name and namespace means the same document identity, so it owns them.
    expect(plan.ownership?.conflicts).toEqual([])

    // A genuinely different document over the same resource is the conflicting case.
    // The mock scopes by workspace name, so this is arranged by seeding the record.
    await h.store.recordOwnership({
      claims: [
        {
          scope: scopeFor('default', 'shared'),
          resourceKey: 'mock.database/main',
          paths: ['region'],
          owner: 'MockWorkspace/default/someone-else',
        },
      ],
      releases: [],
    })

    const contested = await h.runtime.plan({
      desiredState: named(DB('us-east-1'), 'shared'),
      actor: AGENT,
    })

    expect(contested.ownership?.conflicts).toEqual([
      {
        scope: scopeFor('default', 'shared'),
        resourceKey: 'mock.database/main',
        conflicts: [{ path: 'region', owner: 'MockWorkspace/default/someone-else' }],
      },
    ])
    expect(contested.changes[0]?.action).toBe('blocked')
    expect(contested.changes[0]?.blockedBy).toBe('FIELD_OWNERSHIP_CONFLICT')
    expect(contested.changes[0]?.reason).toContain('someone-else')
  })

  it('does not collide across scopes, because a resource key is only unique in one', async () => {
    const h = harness()
    // Two workspaces each hold a `main` database. Same key string, different things.
    await applyDocument(h, named(DB('eu-central-1'), 'shared'), 'a')

    const other = await h.runtime.plan({
      desiredState: named(DB('us-east-1'), 'shared', 'other'),
      actor: AGENT,
    })

    expect(other.ownership?.conflicts).toEqual([])
    expect(other.changes[0]?.action).toBe('create')
  })

  it('leaves a noop alone: it sets nothing, so it takes nothing', async () => {
    const h = harness()
    await applyDocument(h, document(DB()), 'a')

    await h.store.recordOwnership({
      claims: [
        {
          scope: scopeFor('default', 'demo'),
          resourceKey: 'mock.database/main',
          paths: ['region'],
          owner: 'MockWorkspace/default/other',
        },
      ],
      releases: [],
    })

    const plan = await h.runtime.plan({ desiredState: document(DB()), actor: AGENT })
    expect(plan.ownership?.conflicts).toHaveLength(1)
    expect(plan.changes[0]?.action).toBe('noop')
  })

  it('refuses at apply time when a claimed field was taken since planning', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(DB()), actor: AGENT })

    // Someone else claims it between plan and apply.
    await h.store.recordOwnership({
      claims: [
        {
          scope: scopeFor('default', 'demo'),
          resourceKey: 'mock.database/main',
          paths: ['region'],
          owner: 'MockWorkspace/default/faster',
        },
      ],
      releases: [],
    })

    try {
      await h.runtime.apply({ planId: plan.metadata.id, idempotencyKey: 'a', actor: AGENT })
      expect.unreachable('a taken field must stop the apply')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('FIELD_OWNERSHIP_CONFLICT')
    }
  })
})

describe('an update sets only what is declared', () => {
  it('leaves an undeclared attribute alone rather than clearing it', async () => {
    const h = harness()
    await applyDocument(h, document(DB('eu-central-1', 20)), 'a')

    // `sizeGb` is dropped and `region` changes: the update must touch only region.
    await applyDocument(h, document(DB('us-east-1')), 'b')

    const stored = h.backend.get({ namespace: 'default', workspace: 'demo' }, 'mock.database/main')
    expect(stored?.attributes['region']).toBe('us-east-1')
    expect(stored?.attributes['sizeGb']).toBe(20)
  })
})

describe('the plan hash covers ownership', () => {
  it('recomputes to the published hash', async () => {
    const h = harness()
    const plan = await h.runtime.plan({ desiredState: document(DB()), actor: AGENT })
    const record = await h.store.getPlan(plan.metadata.id)
    if (record === null) expect.unreachable('the plan must be stored')
    else expect(computePlanHash(record.plan)).toBe(record.plan.metadata.planHash)
  })

  it('changes once a conflict appears, so an approval cannot survive it', async () => {
    const h = harness()
    const clean = await h.runtime.plan({ desiredState: document(DB()), actor: AGENT })

    await h.store.recordOwnership({
      claims: [
        {
          scope: scopeFor('default', 'demo'),
          resourceKey: 'mock.database/main',
          paths: ['region'],
          owner: 'MockWorkspace/default/other',
        },
      ],
      releases: [],
    })

    const contested = await h.runtime.plan({ desiredState: document(DB()), actor: AGENT })
    expect(contested.metadata.planHash).not.toBe(clean.metadata.planHash)
  })

  it('stays identical for the same document and the same record', async () => {
    const h = harness()
    const first = await h.runtime.plan({ desiredState: document(DB()), actor: AGENT })
    const second = await h.runtime.plan({ desiredState: document(DB()), actor: AGENT })
    expect(second.metadata.planHash).toBe(first.metadata.planHash)
    expect(second.ownership).toEqual(first.ownership)
  })
})

describe('the record survives a release of another owner', () => {
  it('never drops a claim it does not hold', async () => {
    const h = harness()
    const scope = scopeFor('default', 'demo')

    await h.store.recordOwnership({
      claims: [
        { scope, resourceKey: 'r/a', paths: ['x'], owner: 'A' },
        { scope, resourceKey: 'r/a', paths: ['y'], owner: 'B' },
      ],
      releases: [],
    })

    // A releases its own path only.
    await h.store.recordOwnership({
      claims: [],
      releases: [{ scope, resourceKey: 'r/a', paths: ['x', 'y'], owner: 'A' }],
    })

    const snapshot = await h.store.ownershipFor(scope, ['r/a'])
    expect(snapshot.claims).toEqual([{ scope, resourceKey: 'r/a', paths: ['y'], owner: 'B' }])
  })
})
