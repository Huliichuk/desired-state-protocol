import { describe, expect, it } from 'vitest'
import {
  flattenValue,
  getAtPath,
  normalizePathPattern,
  parsePath,
  pathMatches,
  pathMatchesAny,
} from '@dsp/protocol'

describe('flattenValue', () => {
  it('produces one entry per leaf, with bracketed array indices', () => {
    const flat = flattenValue({
      name: 'main',
      tables: [{ name: 'users', columns: [{ name: 'id' }] }],
    })

    expect([...flat.keys()].sort()).toEqual(['name', 'tables[0].columns[0].name', 'tables[0].name'])
    expect(flat.get('tables[0].columns[0].name')).toBe('id')
  })

  it('keeps empty objects and empty arrays as leaves so "became empty" is visible', () => {
    const flat = flattenValue({ tags: [], meta: {} })
    expect(flat.get('tags')).toEqual([])
    expect(flat.get('meta')).toEqual({})
  })

  it('ignores undefined properties', () => {
    expect([...flattenValue({ a: 1, b: undefined }).keys()]).toEqual(['a'])
  })

  it('honours a prefix', () => {
    expect([...flattenValue({ a: 1 }, 'spec').keys()]).toEqual(['spec.a'])
  })

  it('treats null as a leaf value rather than an object', () => {
    expect(flattenValue({ a: null }).get('a')).toBeNull()
  })
})

describe('parsePath and getAtPath', () => {
  it('splits dotted and bracketed segments', () => {
    expect(parsePath('a.b[2].c')).toEqual(['a', 'b', 2, 'c'])
    expect(parsePath('')).toEqual([])
  })

  it('reads nested values', () => {
    const source = { a: { b: [{ c: 'found' }] } }
    expect(getAtPath(source, 'a.b[0].c')).toBe('found')
    expect(getAtPath(source, '')).toBe(source)
  })

  it('returns undefined instead of throwing for paths that do not exist', () => {
    expect(getAtPath({ a: 1 }, 'a.b.c')).toBeUndefined()
    expect(getAtPath({ a: [1] }, 'a[5]')).toBeUndefined()
    expect(getAtPath({ a: [1] }, 'a.b')).toBeUndefined()
    expect(getAtPath(null, 'a')).toBeUndefined()
  })
})

describe('path patterns', () => {
  it('erases array indices so a pattern can cover every element', () => {
    expect(normalizePathPattern('prices[0].currency')).toBe('prices[].currency')
  })

  it('matches a concrete path against an indexed pattern', () => {
    expect(pathMatches('prices[0].currency', 'prices[].currency')).toBe(true)
    expect(pathMatches('prices[3].currency', 'prices[].currency')).toBe(true)
    expect(pathMatches('prices[0].amount', 'prices[].currency')).toBe(false)
  })

  it('covers everything nested under a matched pattern', () => {
    expect(pathMatches('credentials.secretRef.name', 'credentials')).toBe(true)
    expect(pathMatches('credentials[0]', 'credentials')).toBe(true)
    // A shared prefix that is not a path boundary must not match.
    expect(pathMatches('credentialsOther', 'credentials')).toBe(false)
  })

  it('supports a trailing wildcard', () => {
    expect(pathMatches('spec.anything.deep', 'spec.*')).toBe(true)
    expect(pathMatches('other.thing', 'spec.*')).toBe(false)
  })

  it('matches against any pattern in a list', () => {
    expect(pathMatchesAny('a.b', ['x', 'a.b'])).toBe(true)
    expect(pathMatchesAny('a.b', [])).toBe(false)
  })
})
