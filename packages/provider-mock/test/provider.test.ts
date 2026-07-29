import { afterEach, describe, expect, it } from 'vitest'
import {
  DSPError,
  DSP_API_VERSION,
  type DesiredStateDocument,
  type PlanChange,
} from '@dsp/protocol'
import { createTestContext, createTestExecutionContext } from '@dsp/provider-sdk'
import {
  MOCK_RESOURCE_TYPES,
  MockBackend,
  MockProvider,
  databaseKey,
  projectSpec,
  subscriptionKey,
  tableKey,
  userKey,
  type MockWorkspaceSpec,
} from '@dsp/provider-mock'

const backends: MockBackend[] = []

function provider(): MockProvider {
  const backend = new MockBackend(':memory:')
  backends.push(backend)
  return new MockProvider({ backend })
}

afterEach(() => {
  while (backends.length > 0) backends.pop()?.close()
})

function document(spec: MockWorkspaceSpec): DesiredStateDocument<MockWorkspaceSpec> {
  return {
    apiVersion: DSP_API_VERSION,
    kind: 'MockWorkspace',
    metadata: { name: 'demo' },
    spec,
  }
}

function change(overrides: Partial<PlanChange> = {}): PlanChange {
  return {
    id: 'chg_1',
    resourceType: MOCK_RESOURCE_TYPES.database,
    resourceKey: databaseKey('main'),
    action: 'create',
    fields: [],
    reason: 'r',
    reversible: false,
    destructive: false,
    dependencies: [],
    estimatedRisk: 'low',
    after: { name: 'main', engine: 'postgres', region: 'eu-central-1' },
    ...overrides,
  }
}

const workspace = { namespace: 'default', workspace: 'demo' }

describe('projectSpec', () => {
  it('turns document nesting into explicit dependency edges', () => {
    const projection = projectSpec({
      databases: [
        {
          name: 'main',
          engine: 'postgres',
          region: 'eu',
          tables: [{ name: 'users', columns: [{ name: 'id', type: 'text' }] }],
        },
      ],
      users: [{ email: 'a@b.c', role: 'admin' }],
      subscriptions: [{ user: 'a@b.c', plan: 'pro', amountCents: 100, currency: 'eur' }],
    })

    const byKey = new Map(projection.resources.map((resource) => [resource.key, resource]))
    expect(byKey.get(tableKey('main', 'users'))?.dependsOn).toEqual([databaseKey('main')])
    expect(byKey.get(subscriptionKey('a@b.c'))?.dependsOn).toEqual([userKey('a@b.c')])
    expect(byKey.get(databaseKey('main'))?.dependsOn).toBeUndefined()
  })

  it('produces stable keys built from the identity fields', () => {
    expect(databaseKey('main')).toBe('mock.database/main')
    expect(tableKey('main', 'users')).toBe('mock.table/main.users')
    expect(userKey('a@b.c')).toBe('mock.user/a@b.c')
    expect(subscriptionKey('a@b.c')).toBe('mock.subscription/a@b.c')
  })

  it('omits absent optional fields rather than setting them to undefined', () => {
    const [database] = projectSpec({
      databases: [{ name: 'main', engine: 'postgres', region: 'eu' }],
    }).resources
    expect(Object.keys(database?.attributes ?? {}).sort()).toEqual(['engine', 'name', 'region'])
  })

  it('defaults a subscription to active and a column to non-nullable', () => {
    const projection = projectSpec({
      databases: [
        {
          name: 'd',
          engine: 'sqlite',
          region: 'eu',
          tables: [{ name: 't', columns: [{ name: 'c', type: 'text' }] }],
        },
      ],
      users: [{ email: 'a@b.c', role: 'admin' }],
      subscriptions: [{ user: 'a@b.c', plan: 'p', amountCents: 1, currency: 'eur' }],
    })
    const byKey = new Map(projection.resources.map((resource) => [resource.key, resource]))
    expect(byKey.get(subscriptionKey('a@b.c'))?.attributes['active']).toBe(true)
    expect(
      (byKey.get(tableKey('d', 't'))?.attributes['columns'] as Array<{ nullable: boolean }>)[0]
        ?.nullable,
    ).toBe(false)
  })

  it('projects an empty spec into no resources', () => {
    expect(projectSpec({}).resources).toEqual([])
  })
})

describe('MockProvider.requiredSecrets', () => {
  it('declares nothing when the document carries no credentials', () => {
    expect(provider().requiredSecrets(document({}))).toEqual([])
  })

  it('declares exactly the reference the document names', () => {
    const doc = document({ credentials: { secretRef: { name: 'mock-api' } } })
    expect(provider().requiredSecrets(doc)).toEqual([{ name: 'mock-api' }])
  })
})

describe('MockProvider.validate', () => {
  const context = createTestContext()

  it('accepts a well-formed document', async () => {
    const result = await provider().validate(
      context,
      document({
        databases: [{ name: 'main', engine: 'postgres', region: 'eu' }],
        users: [{ email: 'a@b.c', role: 'admin' }],
      }),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a duplicate database', async () => {
    const result = await provider().validate(
      context,
      document({
        databases: [
          { name: 'main', engine: 'postgres', region: 'eu' },
          { name: 'main', engine: 'mysql', region: 'eu' },
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toMatchObject({
      code: 'DUPLICATE_RESOURCE',
      path: 'spec.databases[1].name',
    })
  })

  it('rejects a duplicate table inside one database', async () => {
    const result = await provider().validate(
      context,
      document({
        databases: [
          {
            name: 'main',
            engine: 'postgres',
            region: 'eu',
            tables: [
              { name: 'users', columns: [{ name: 'id', type: 'text' }] },
              { name: 'users', columns: [{ name: 'id', type: 'text' }] },
            ],
          },
        ],
      }),
    )
    expect(result.errors[0]?.path).toBe('spec.databases[0].tables[1].name')
  })

  it('rejects a duplicate column', async () => {
    const result = await provider().validate(
      context,
      document({
        databases: [
          {
            name: 'main',
            engine: 'postgres',
            region: 'eu',
            tables: [
              {
                name: 'users',
                columns: [
                  { name: 'id', type: 'text' },
                  { name: 'id', type: 'text' },
                ],
              },
            ],
          },
        ],
      }),
    )
    expect(result.errors[0]?.code).toBe('DUPLICATE_RESOURCE')
  })

  it('rejects a duplicate user and a duplicate subscription', async () => {
    const result = await provider().validate(
      context,
      document({
        users: [
          { email: 'a@b.c', role: 'admin' },
          { email: 'a@b.c', role: 'viewer' },
        ],
        subscriptions: [
          { user: 'a@b.c', plan: 'p', amountCents: 1, currency: 'eur' },
          { user: 'a@b.c', plan: 'q', amountCents: 2, currency: 'eur' },
        ],
      }),
    )
    expect(result.errors.filter((issue) => issue.code === 'DUPLICATE_RESOURCE')).toHaveLength(2)
  })

  it('rejects a subscription for a user the document never declares', async () => {
    const result = await provider().validate(
      context,
      document({
        subscriptions: [{ user: 'ghost@b.c', plan: 'p', amountCents: 1, currency: 'eur' }],
      }),
    )
    expect(result.errors[0]).toMatchObject({
      code: 'UNRESOLVED_REFERENCE',
      path: 'spec.subscriptions[0].user',
    })
  })

  it('warns about an inline API token without rejecting the document', async () => {
    const result = await provider().validate(
      context,
      document({ users: [{ email: 'a@b.c', role: 'admin', apiToken: 'inline' }] }),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings[0]).toMatchObject({
      code: 'INLINE_SECRET',
      path: 'spec.users[0].apiToken',
    })
  })

  it('reports an immutable engine change against the existing world', async () => {
    const instance = provider()
    instance.backend.upsert(workspace, {
      resourceType: MOCK_RESOURCE_TYPES.database,
      key: databaseKey('main'),
      attributes: { name: 'main', engine: 'postgres', region: 'eu' },
    })

    const result = await instance.validate(
      context,
      document({ databases: [{ name: 'main', engine: 'mysql', region: 'eu' }] }),
    )
    expect(result.errors[0]).toMatchObject({
      code: 'IMMUTABLE_FIELD_CHANGED',
      path: 'spec.databases[0].engine',
    })
    expect(result.errors[0]?.message).toContain('postgres')
  })

  it('reports an immutable currency change against the existing world', async () => {
    const instance = provider()
    instance.backend.upsert(workspace, {
      resourceType: MOCK_RESOURCE_TYPES.subscription,
      key: subscriptionKey('a@b.c'),
      attributes: { user: 'a@b.c', plan: 'pro', amountCents: 100, currency: 'eur' },
    })

    const result = await instance.validate(
      context,
      document({
        users: [{ email: 'a@b.c', role: 'admin' }],
        subscriptions: [{ user: 'a@b.c', plan: 'pro', amountCents: 100, currency: 'usd' }],
      }),
    )
    expect(result.errors[0]?.code).toBe('IMMUTABLE_FIELD_CHANGED')
  })
})

describe('MockProvider.inspect', () => {
  it('reports an empty world with a stable revision', async () => {
    const current = await provider().inspect(createTestContext(), document({}))
    expect(current.state).toEqual({ resources: [] })
    expect(current.revision).toBe('empty')
    expect(current.resourceId).toBe('default/demo')
  })

  it('changes the revision once anything exists', async () => {
    const instance = provider()
    const before = await instance.inspect(createTestContext(), document({}))
    instance.backend.upsert(workspace, {
      resourceType: MOCK_RESOURCE_TYPES.database,
      key: databaseKey('main'),
      attributes: { name: 'main' },
    })
    const after = await instance.inspect(createTestContext(), document({}))
    expect(after.revision).not.toBe(before.revision)
  })

  it('honours an aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      provider().inspect(createTestContext({ signal: controller.signal }), document({})),
    ).rejects.toThrow()
  })

  it('keeps workspaces in different namespaces separate', async () => {
    const instance = provider()
    instance.backend.upsert(
      { namespace: 'other', workspace: 'demo' },
      { resourceType: MOCK_RESOURCE_TYPES.database, key: databaseKey('main'), attributes: {} },
    )
    const current = await instance.inspect(createTestContext(), document({}))
    expect(current.state?.resources).toEqual([])
  })
})

describe('MockProvider.applyChange', () => {
  const doc = document({ databases: [{ name: 'main', engine: 'postgres', region: 'eu' }] })

  it('creates the resource described by the change', async () => {
    const instance = provider()
    const result = await instance.applyChange(
      createTestExecutionContext({ desired: doc as DesiredStateDocument }),
      change(),
    )

    expect(result.externalId).toMatch(/^database_/)
    expect(result.providerRequestId).toMatch(/^mockreq_/)
    expect(instance.backend.get(workspace, databaseKey('main'))?.attributes).toEqual({
      name: 'main',
      engine: 'postgres',
      region: 'eu-central-1',
    })
  })

  it('is idempotent: the same change applied twice leaves one resource', async () => {
    const instance = provider()
    const context = createTestExecutionContext({ desired: doc as DesiredStateDocument })
    const first = await instance.applyChange(context, change())
    const second = await instance.applyChange(context, change())

    expect(second.externalId).toBe(first.externalId)
    expect(instance.backend.list(workspace)).toHaveLength(1)
  })

  it('refuses to execute a change the runtime should never hand it', async () => {
    const instance = provider()
    const context = createTestExecutionContext({ desired: doc as DesiredStateDocument })

    for (const action of ['noop', 'blocked'] as const) {
      try {
        await instance.applyChange(context, change({ action }))
        expect.unreachable(`a ${action} change must not be executable`)
      } catch (error) {
        if (!DSPError.isDSPError(error)) throw error
        expect(error.code).toBe('UNSUPPORTED_OPERATION')
      }
    }
  })

  it('refuses a change with no target attributes', async () => {
    const instance = provider()
    const withoutAfter = { ...change() }
    delete (withoutAfter as { after?: unknown }).after

    await expect(
      instance.applyChange(
        createTestExecutionContext({ desired: doc as DesiredStateDocument }),
        withoutAfter,
      ),
    ).rejects.toThrow(/no target attributes/)
  })

  it('deletes an existing resource and reports a missing one', async () => {
    const instance = provider()
    const context = createTestExecutionContext({ desired: doc as DesiredStateDocument })
    await instance.applyChange(context, change())

    const removal = change({ action: 'delete' })
    await instance.applyChange(context, removal)
    expect(instance.backend.get(workspace, databaseKey('main'))).toBeNull()

    await expect(instance.applyChange(context, removal)).rejects.toThrow(/no longer exists/)
  })
})

describe('MockProvider failure simulation', () => {
  const simulated = (simulate: MockWorkspaceSpec['simulate']): DesiredStateDocument =>
    document({
      databases: [{ name: 'main', engine: 'postgres', region: 'eu' }],
      ...(simulate === undefined ? {} : { simulate }),
    }) as DesiredStateDocument

  it('raises a retryable error for a transient failure', async () => {
    const doc = simulated({ failResourceKey: databaseKey('main'), failureMode: 'retryable' })
    try {
      await provider().applyChange(createTestExecutionContext({ desired: doc }), change())
      expect.unreachable('the simulated failure must surface')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('PROVIDER_ERROR')
      expect(error.retryable).toBe(true)
    }
  })

  it('raises a non-retryable error for a permanent failure', async () => {
    const doc = simulated({ failResourceKey: databaseKey('main'), failureMode: 'permanent' })
    try {
      await provider().applyChange(createTestExecutionContext({ desired: doc }), change())
      expect.unreachable('the simulated failure must surface')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.retryable).toBe(false)
    }
  })

  it('defaults an unspecified failure mode to permanent', async () => {
    const doc = simulated({ failResourceKey: databaseKey('main') })
    await expect(
      provider().applyChange(createTestExecutionContext({ desired: doc }), change()),
    ).rejects.toThrow(/permanent failure/)
  })

  it('hangs until the context is aborted for a timeout failure', async () => {
    const doc = simulated({ failResourceKey: databaseKey('main'), failureMode: 'timeout' })
    const context = createTestExecutionContext({
      desired: doc,
      signal: AbortSignal.timeout(30),
    })
    await expect(provider().applyChange(context, change())).rejects.toThrow()
  })

  it('fails only the first attempts when failAttempts is set', async () => {
    const doc = simulated({
      failResourceKey: databaseKey('main'),
      failureMode: 'retryable',
      failAttempts: 1,
    })
    const instance = provider()

    await expect(
      instance.applyChange(createTestExecutionContext({ desired: doc, attempt: 1 }), change()),
    ).rejects.toThrow()

    const result = await instance.applyChange(
      createTestExecutionContext({ desired: doc, attempt: 2 }),
      change(),
    )
    expect(result.externalId).toMatch(/^database_/)
  })

  it('leaves other resources untouched when one is configured to fail', async () => {
    const doc = simulated({ failResourceKey: 'mock.database/other' })
    const instance = provider()
    const result = await instance.applyChange(
      createTestExecutionContext({ desired: doc }),
      change(),
    )
    expect(result.externalId).not.toBeNull()
  })

  it('corrupts state after apply when drift is simulated', async () => {
    const doc = simulated({ driftResourceKey: databaseKey('main') })
    const instance = provider()
    await instance.applyChange(createTestExecutionContext({ desired: doc }), change())

    expect(instance.backend.get(workspace, databaseKey('main'))?.attributes['region']).toBe(
      'drifted-region',
    )
  })
})

describe('MockProvider.plan refinement', () => {
  it('marks the removal of admin access destructive', async () => {
    const refined = await provider().plan?.(createTestContext(), {
      desired: document({}),
      current: { resourceType: 'MockWorkspace', resourceId: null, observedAt: '', state: null },
      changes: [
        change({
          resourceType: MOCK_RESOURCE_TYPES.user,
          resourceKey: userKey('a@b.c'),
          action: 'update',
          fields: [{ path: 'role', before: 'admin', after: 'viewer', immutable: false }],
        }),
      ],
    })

    expect(refined?.[0]?.destructive).toBe(true)
    expect(refined?.[0]?.reversible).toBe(false)
    expect(refined?.[0]?.reason).toContain('admin')
  })

  it('leaves a promotion to admin alone', async () => {
    const refined = await provider().plan?.(createTestContext(), {
      desired: document({}),
      current: { resourceType: 'MockWorkspace', resourceId: null, observedAt: '', state: null },
      changes: [
        change({
          resourceType: MOCK_RESOURCE_TYPES.user,
          resourceKey: userKey('a@b.c'),
          action: 'update',
          fields: [{ path: 'role', before: 'viewer', after: 'admin', immutable: false }],
        }),
      ],
    })
    expect(refined?.[0]?.destructive).toBe(false)
  })

  it('leaves changes to other resource types alone', async () => {
    const original = change()
    const refined = await provider().plan?.(createTestContext(), {
      desired: document({}),
      current: { resourceType: 'MockWorkspace', resourceId: null, observedAt: '', state: null },
      changes: [original],
    })
    expect(refined?.[0]).toBe(original)
  })
})
