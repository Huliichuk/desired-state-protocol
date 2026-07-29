import { describe, expect, it } from 'vitest'
import { DSPError, DSP_API_VERSION } from '@dsp/protocol'
import { desiredStateHash, normalizeProjection } from '@dsp/plan-engine'
import { DB_TYPE, projection, resource } from './fixtures.js'

describe('normalizeProjection', () => {
  it('sorts resources by key so iteration order never depends on the provider', () => {
    const normalized = normalizeProjection(
      projection(
        resource(DB_TYPE, 'z', { name: 'z' }),
        resource(DB_TYPE, 'a', { name: 'a' }),
        resource(DB_TYPE, 'm', { name: 'm' }),
      ),
    )
    expect(normalized.resources.map((item) => item.key)).toEqual(['a', 'm', 'z'])
  })

  it('indexes resources by key', () => {
    const normalized = normalizeProjection(projection(resource(DB_TYPE, 'a', { name: 'a' })))
    expect(normalized.byKey.get('a')?.attributes).toEqual({ name: 'a' })
  })

  it('canonicalizes attribute key order', () => {
    const normalized = normalizeProjection(projection(resource(DB_TYPE, 'a', { b: 1, a: 2 })))
    expect(Object.keys(normalized.resources[0]?.attributes ?? {})).toEqual(['a', 'b'])
  })

  it('sorts dependsOn and defaults externalId to null', () => {
    const normalized = normalizeProjection(projection(resource(DB_TYPE, 'a', {}, ['z', 'b'])))
    expect(normalized.resources[0]?.dependsOn).toEqual(['b', 'z'])
    expect(normalized.resources[0]?.externalId).toBeNull()
  })

  it('rejects duplicate resource keys instead of silently dropping one', () => {
    const duplicated = projection(
      resource(DB_TYPE, 'a', { name: 'a' }),
      resource(DB_TYPE, 'a', { name: 'other' }),
    )
    expect(() => normalizeProjection(duplicated)).toThrow(DSPError)
    expect(() => normalizeProjection(duplicated)).toThrow(/Duplicate resource key/)
  })

  it('produces a hash that ignores input order but reacts to content', () => {
    const one = normalizeProjection(
      projection(resource(DB_TYPE, 'a', { x: 1 }), resource(DB_TYPE, 'b', { y: 2 })),
    )
    const shuffled = normalizeProjection(
      projection(resource(DB_TYPE, 'b', { y: 2 }), resource(DB_TYPE, 'a', { x: 1 })),
    )
    const changed = normalizeProjection(
      projection(resource(DB_TYPE, 'a', { x: 9 }), resource(DB_TYPE, 'b', { y: 2 })),
    )

    expect(one.hash).toBe(shuffled.hash)
    expect(one.hash).not.toBe(changed.hash)
  })

  it('hashes an empty projection to a stable value', () => {
    expect(normalizeProjection({ resources: [] }).hash).toBe(
      normalizeProjection({ resources: [] }).hash,
    )
  })
})

describe('desiredStateHash', () => {
  const base = {
    apiVersion: DSP_API_VERSION,
    kind: 'TestWorkspace',
    metadata: { name: 'demo' },
    spec: { size: 1 },
  } as const

  it('ignores metadata.requestId, which is correlation data rather than desired state', () => {
    expect(desiredStateHash({ ...base, metadata: { ...base.metadata, requestId: 'req_1' } })).toBe(
      desiredStateHash(base),
    )
  })

  it('reacts to a spec change', () => {
    expect(desiredStateHash({ ...base, spec: { size: 2 } })).not.toBe(desiredStateHash(base))
  })

  it('reacts to labels, which are part of the document', () => {
    expect(
      desiredStateHash({ ...base, metadata: { ...base.metadata, labels: { team: 'a' } } }),
    ).not.toBe(desiredStateHash(base))
  })

  it('reacts to the namespace and the name', () => {
    expect(desiredStateHash({ ...base, metadata: { name: 'other' } })).not.toBe(
      desiredStateHash(base),
    )
    expect(
      desiredStateHash({ ...base, metadata: { ...base.metadata, namespace: 'team-a' } }),
    ).not.toBe(desiredStateHash(base))
  })
})
