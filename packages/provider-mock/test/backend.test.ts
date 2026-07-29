import { afterEach, describe, expect, it } from 'vitest'
import { MOCK_RESOURCE_TYPES, MockBackend } from '@dsp/provider-mock'

const open: MockBackend[] = []

function backend(): MockBackend {
  const instance = new MockBackend(':memory:')
  open.push(instance)
  return instance
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close()
})

const workspace = { namespace: 'default', workspace: 'demo' }
const other = { namespace: 'default', workspace: 'another' }

const database = (attributes: Record<string, unknown>) => ({
  resourceType: MOCK_RESOURCE_TYPES.database,
  key: 'mock.database/main',
  attributes,
})

describe('MockBackend', () => {
  it('stores and reads back a resource', () => {
    const store = backend()
    const stored = store.upsert(workspace, database({ name: 'main', engine: 'postgres' }))

    expect(stored.externalId).toMatch(/^database_/)
    expect(store.get(workspace, 'mock.database/main')?.attributes).toEqual({
      name: 'main',
      engine: 'postgres',
    })
  })

  it('returns null for a resource it does not hold', () => {
    expect(backend().get(workspace, 'mock.database/absent')).toBeNull()
  })

  it('keeps the external id stable across updates, the way a real API would', () => {
    const store = backend()
    const created = store.upsert(workspace, database({ name: 'main', sizeGb: 10 }))
    const updated = store.upsert(workspace, database({ name: 'main', sizeGb: 20 }))

    expect(updated.externalId).toBe(created.externalId)
    expect(store.list(workspace)).toHaveLength(1)
  })

  it('is idempotent for identical attributes', () => {
    const store = backend()
    const attributes = { name: 'main', engine: 'postgres' }
    const first = store.upsert(workspace, database(attributes))
    const second = store.upsert(workspace, database(attributes))

    expect(second.revision).toBe(first.revision)
    expect(store.list(workspace)).toHaveLength(1)
  })

  it('lists resources ordered by key so reads are reproducible', () => {
    const store = backend()
    store.upsert(workspace, { resourceType: 'mock.user', key: 'mock.user/z', attributes: {} })
    store.upsert(workspace, { resourceType: 'mock.user', key: 'mock.user/a', attributes: {} })

    expect(store.list(workspace).map((resource) => resource.key)).toEqual([
      'mock.user/a',
      'mock.user/z',
    ])
  })

  it('isolates workspaces from each other', () => {
    const store = backend()
    store.upsert(workspace, database({ name: 'main' }))

    expect(store.list(other)).toEqual([])
    expect(store.revision(other)).toBe('empty')
  })

  it('reports an empty workspace with a fixed revision', () => {
    expect(backend().revision(workspace)).toBe('empty')
  })

  it('changes the workspace revision whenever any resource changes', () => {
    const store = backend()
    const empty = store.revision(workspace)

    store.upsert(workspace, database({ name: 'main', sizeGb: 10 }))
    const created = store.revision(workspace)

    store.upsert(workspace, database({ name: 'main', sizeGb: 20 }))
    const updated = store.revision(workspace)

    expect(new Set([empty, created, updated]).size).toBe(3)
  })

  it('returns to the same revision when the state returns to the same value', () => {
    const store = backend()
    store.upsert(workspace, database({ name: 'main', sizeGb: 10 }))
    const original = store.revision(workspace)

    store.upsert(workspace, database({ name: 'main', sizeGb: 20 }))
    store.upsert(workspace, database({ name: 'main', sizeGb: 10 }))

    expect(store.revision(workspace)).toBe(original)
  })

  it('deletes a resource and reports whether anything was removed', () => {
    const store = backend()
    store.upsert(workspace, database({ name: 'main' }))

    expect(store.delete(workspace, 'mock.database/main')).toBe(true)
    expect(store.delete(workspace, 'mock.database/main')).toBe(false)
    expect(store.list(workspace)).toEqual([])
  })

  it('injects drift the way an out-of-band change would', () => {
    const store = backend()
    store.upsert(workspace, database({ name: 'main', region: 'eu' }))

    expect(store.injectDrift(workspace, 'mock.database/main', { region: 'us' })).toBe(true)
    expect(store.get(workspace, 'mock.database/main')?.attributes).toEqual({
      name: 'main',
      region: 'us',
    })
  })

  it('cannot inject drift into a resource that does not exist', () => {
    expect(backend().injectDrift(workspace, 'mock.database/absent', { a: 1 })).toBe(false)
  })

  it('clears everything on reset', () => {
    const store = backend()
    store.upsert(workspace, database({ name: 'main' }))
    store.reset()
    expect(store.list(workspace)).toEqual([])
  })

  it('gives each in-memory instance its own world', () => {
    const first = backend()
    const second = backend()
    first.upsert(workspace, database({ name: 'main' }))

    expect(second.list(workspace)).toEqual([])
  })

  it('uses an injectable clock so timestamps stay deterministic in tests', () => {
    const store = backend()
    store.setClock(() => new Date('2026-07-29T18:00:00.000Z'))
    const stored = store.upsert(workspace, database({ name: 'main' }))
    expect(stored.updatedAt).toBe('2026-07-29T18:00:00.000Z')
  })

  it('round-trips nested attribute structures through storage', () => {
    const store = backend()
    const attributes = {
      database: 'main',
      name: 'users',
      columns: [{ name: 'id', type: 'text', nullable: false }],
    }
    store.upsert(workspace, {
      resourceType: MOCK_RESOURCE_TYPES.table,
      key: 'mock.table/main.users',
      attributes,
    })
    expect(store.get(workspace, 'mock.table/main.users')?.attributes).toEqual(attributes)
  })
})
