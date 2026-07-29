import { describe, expect, it } from 'vitest'
import { DSPError, type PlanChange } from '@dsp/protocol'
import {
  DEFAULT_DIFF_OPTIONS,
  assertChangeLimit,
  computeChanges,
  fieldDiffs,
  normalizeProjection,
} from '@dsp/plan-engine'
import {
  DB_TYPE,
  READONLY_TYPE,
  SUB_TYPE,
  TABLE_TYPE,
  projection,
  resource,
  resourceTypes,
} from './fixtures.js'

interface DiffCase {
  desired?: ReturnType<typeof projection>
  current?: ReturnType<typeof projection>
  allowDelete?: boolean
  allowReplace?: boolean
}

function diff({ desired, current, allowDelete, allowReplace }: DiffCase): PlanChange[] {
  return computeChanges({
    desired: normalizeProjection(desired ?? { resources: [] }),
    current: normalizeProjection(current ?? { resources: [] }),
    resourceTypes,
    options: {
      ...DEFAULT_DIFF_OPTIONS,
      ...(allowDelete === undefined ? {} : { allowDelete }),
      ...(allowReplace === undefined ? {} : { allowReplace }),
    },
  })
}

const db = (attributes: Record<string, unknown>) => resource(DB_TYPE, 'db/main', attributes)

describe('computeChanges — actions', () => {
  it('creates a resource that does not exist yet', () => {
    const [change] = diff({ desired: projection(db({ name: 'main', engine: 'postgres' })) })
    expect(change?.action).toBe('create')
    expect(change?.after).toEqual({ name: 'main', engine: 'postgres' })
    expect(change).not.toHaveProperty('before')
    expect(change?.destructive).toBe(false)
    // Creating is only undoable by deleting, which this runtime blocks.
    expect(change?.reversible).toBe(false)
  })

  it('reports noop when the desired state already holds', () => {
    const attributes = { name: 'main', engine: 'postgres' }
    const [change] = diff({
      desired: projection(db(attributes)),
      current: projection(db(attributes)),
    })
    expect(change?.action).toBe('noop')
    expect(change?.fields).toEqual([])
    expect(change?.reversible).toBe(true)
  })

  it('ignores attribute ordering when deciding that nothing changed', () => {
    const [change] = diff({
      desired: projection(db({ name: 'main', engine: 'postgres' })),
      current: projection(db({ engine: 'postgres', name: 'main' })),
    })
    expect(change?.action).toBe('noop')
  })

  it('updates when a mutable field changes', () => {
    const [change] = diff({
      desired: projection(db({ name: 'main', engine: 'postgres', sizeGb: 40 })),
      current: projection(db({ name: 'main', engine: 'postgres', sizeGb: 20 })),
    })
    expect(change?.action).toBe('update')
    expect(change?.reversible).toBe(true)
    expect(change?.fields).toEqual([{ path: 'sizeGb', before: 20, after: 40, immutable: false }])
    // A single-field change also reports the path directly.
    expect(change?.path).toBe('sizeGb')
  })

  it('replaces when an immutable field changes, and marks it destructive', () => {
    const [change] = diff({
      desired: projection(db({ name: 'main', engine: 'mysql' })),
      current: projection(db({ name: 'main', engine: 'postgres' })),
      allowReplace: true,
    })
    expect(change?.action).toBe('replace')
    expect(change?.destructive).toBe(true)
    expect(change?.reversible).toBe(false)
    expect(change?.reason).toContain('immutable')
  })

  it('deletes a resource that is no longer described', () => {
    const [change] = diff({ current: projection(db({ name: 'main' })), allowDelete: true })
    expect(change?.action).toBe('delete')
    expect(change?.destructive).toBe(true)
    expect(change?.before).toEqual({ name: 'main' })
    expect(change).not.toHaveProperty('after')
  })
})

describe('computeChanges — blocking', () => {
  it('blocks a delete when deletions are disabled but still shows what would be lost', () => {
    const [change] = diff({ current: projection(db({ name: 'main' })) })
    expect(change?.action).toBe('blocked')
    expect(change?.blockedBy).toBe('DESTRUCTIVE_ACTION_BLOCKED')
    expect(change?.reason).toContain('intended action: delete')
    expect(change?.before).toEqual({ name: 'main' })
  })

  it('blocks a replace when replacements are disabled', () => {
    const [change] = diff({
      desired: projection(db({ name: 'main', engine: 'mysql' })),
      current: projection(db({ name: 'main', engine: 'postgres' })),
    })
    expect(change?.action).toBe('blocked')
    expect(change?.blockedBy).toBe('DESTRUCTIVE_ACTION_BLOCKED')
    expect(change?.reason).toContain('intended action: replace')
  })

  it('blocks a delete the resource type does not support even when deletions are allowed', () => {
    const [change] = diff({
      current: projection(resource(TABLE_TYPE, 'tbl/users', { name: 'users' })),
      allowDelete: true,
    })
    expect(change?.action).toBe('blocked')
    expect(change?.blockedBy).toBe('UNSUPPORTED_OPERATION')
  })

  it('blocks every non-noop change on a resource type that cannot be applied', () => {
    const [change] = diff({
      desired: projection(resource(READONLY_TYPE, 'ro/a', { name: 'a' })),
    })
    expect(change?.action).toBe('blocked')
    expect(change?.blockedBy).toBe('UNSUPPORTED_OPERATION')
  })

  it('never blocks a noop', () => {
    const attributes = { name: 'a' }
    const [change] = diff({
      desired: projection(resource(READONLY_TYPE, 'ro/a', attributes)),
      current: projection(resource(READONLY_TYPE, 'ro/a', attributes)),
    })
    expect(change?.action).toBe('noop')
  })

  it('keeps the change id stable regardless of whether the change was blocked', () => {
    const blocked = diff({ current: projection(db({ name: 'main' })) })[0]
    const allowed = diff({ current: projection(db({ name: 'main' })), allowDelete: true })[0]
    expect(blocked?.id).toBe(allowed?.id)
  })
})

describe('computeChanges — dependencies', () => {
  const desired = projection(
    resource(DB_TYPE, 'db/main', { name: 'main' }),
    resource(TABLE_TYPE, 'tbl/users', { name: 'users' }, ['db/main']),
  )

  it('translates resource dependencies into change ids', () => {
    const changes = diff({ desired })
    const database = changes.find((change) => change.resourceKey === 'db/main')
    const table = changes.find((change) => change.resourceKey === 'tbl/users')
    expect(table?.dependencies).toEqual([database?.id])
    expect(database?.dependencies).toEqual([])
  })

  it('ignores dependencies on resources that are not part of this plan', () => {
    const changes = diff({
      desired: projection(resource(TABLE_TYPE, 'tbl/users', { name: 'users' }, ['db/absent'])),
    })
    expect(changes[0]?.dependencies).toEqual([])
  })

  it('reverses dependency order for deletions so dependents go first', () => {
    const changes = diff({ current: desired, allowDelete: true })
    const database = changes.find((change) => change.resourceKey === 'db/main')
    const table = changes.find((change) => change.resourceKey === 'tbl/users')
    // The table blocks (its type forbids delete) but the edge is still inverted.
    expect(database?.dependencies).toEqual([table?.id])
  })
})

describe('fieldDiffs', () => {
  const tableType = resourceTypes.get(TABLE_TYPE)

  it('flags a genuine change on an immutable path', () => {
    const diffs = fieldDiffs(
      { columns: [{ name: 'id', type: 'text' }] },
      { columns: [{ name: 'id', type: 'integer' }] },
      tableType,
    )
    expect(diffs).toEqual([
      { path: 'columns[0].type', before: 'text', after: 'integer', immutable: true },
    ])
  })

  it('treats an added path as an addition, not a mutation of an immutable field', () => {
    const diffs = fieldDiffs(
      { columns: [{ name: 'id', type: 'text' }] },
      {
        columns: [
          { name: 'id', type: 'text' },
          { name: 'seen', type: 'timestamp' },
        ],
      },
      tableType,
    )
    expect(diffs.every((entry) => entry.immutable === false)).toBe(true)
    expect(diffs.map((entry) => entry.path)).toEqual(['columns[1].name', 'columns[1].type'])
  })

  it('treats a removed path as a removal, not a mutation of an immutable field', () => {
    const diffs = fieldDiffs(
      {
        columns: [
          { name: 'id', type: 'text' },
          { name: 'seen', type: 'timestamp' },
        ],
      },
      { columns: [{ name: 'id', type: 'text' }] },
      tableType,
    )
    expect(diffs.every((entry) => entry.immutable === false)).toBe(true)
  })

  it('reports missing values as null so the diff is always JSON-safe', () => {
    const [entry] = fieldDiffs({}, { added: 1 }, undefined)
    expect(entry).toEqual({ path: 'added', before: null, after: 1, immutable: false })
  })

  it('returns no diffs for structurally equal objects', () => {
    expect(fieldDiffs({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }, undefined)).toEqual([])
  })

  it('does not report a container alongside the leaves that replaced it', () => {
    // An empty container is a leaf so that "became empty" stays visible, but once
    // the other side expanded it, only the real leaf changes are interesting.
    expect(fieldDiffs({ tags: [] }, { tags: ['a'] }, undefined)).toEqual([
      { path: 'tags[0]', before: null, after: 'a', immutable: false },
    ])
    expect(fieldDiffs({ meta: {} }, { meta: { a: 1 } }, undefined)).toEqual([
      { path: 'meta.a', before: null, after: 1, immutable: false },
    ])
  })

  it('does not report a container when its contents were removed', () => {
    expect(fieldDiffs({ tags: ['a'] }, { tags: [] }, undefined)).toEqual([
      { path: 'tags[0]', before: 'a', after: null, immutable: false },
    ])
  })

  it('still reports a container that genuinely became empty on both sides', () => {
    expect(fieldDiffs({ meta: { a: 1 } }, { meta: {} }, undefined)).toEqual([
      { path: 'meta.a', before: 1, after: null, immutable: false },
    ])
  })

  it('has no immutable fields to consult when the resource type is unknown', () => {
    const diffs = fieldDiffs({ currency: 'eur' }, { currency: 'usd' }, undefined)
    expect(diffs[0]?.immutable).toBe(false)
  })
})

describe('assertChangeLimit', () => {
  it('accepts a change set at the limit and rejects one above it', () => {
    const changes = diff({
      desired: projection(
        resource(SUB_TYPE, 'sub/a', { user: 'a' }),
        resource(SUB_TYPE, 'sub/b', { user: 'b' }),
      ),
    })
    expect(() => assertChangeLimit(changes, 2)).not.toThrow()
    expect(() => assertChangeLimit(changes, 1)).toThrow(DSPError)
    expect(() => assertChangeLimit(changes, 1)).toThrow(/limit is 1/)
  })
})
