import { describe, expect, it } from 'vitest'
import {
  DSPError,
  canonicalEquals,
  canonicalValue,
  canonicalize,
  hashCanonical,
  hashEquals,
  isHash,
  shortHash,
} from '@dsp/protocol'

describe('canonicalize', () => {
  it('sorts object keys so insertion order cannot change the output', () => {
    const a = { b: 1, a: 2, c: 3 }
    const b = { c: 3, a: 2, b: 1 }
    expect(canonicalize(a)).toBe('{"a":2,"b":1,"c":3}')
    expect(canonicalize(a)).toBe(canonicalize(b))
  })

  it('sorts by UTF-16 code unit, not by locale', () => {
    // A locale-aware sort would order these differently.
    expect(canonicalize({ Z: 1, a: 2, A: 3 })).toBe('{"A":3,"Z":1,"a":2}')
  })

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalize([3, 1, 2])).not.toBe(canonicalize([1, 2, 3]))
  })

  it('drops undefined object properties but keeps undefined array slots as null', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalize([1, undefined, 2])).toBe('[1,null,2]')
  })

  it('normalizes negative zero so equal numbers hash equally', () => {
    expect(canonicalize({ v: -0 })).toBe('{"v":0}')
    expect(canonicalize(-0)).toBe(canonicalize(0))
  })

  it('rejects non-finite numbers instead of emitting invalid JSON', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(DSPError)
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/Non-finite/)
  })

  it('rejects values that have no JSON representation', () => {
    expect(() => canonicalize(undefined)).toThrow(DSPError)
    expect(() => canonicalize(() => 1)).toThrow(DSPError)
    expect(() => canonicalize(Symbol('x'))).toThrow(DSPError)
    expect(() => canonicalize(1n)).toThrow(/BigInt/)
  })

  it('serializes dates as ISO strings', () => {
    expect(canonicalize({ at: new Date('2026-07-29T18:00:00.000Z') })).toBe(
      '{"at":"2026-07-29T18:00:00.000Z"}',
    )
  })

  it('guards against unbounded nesting', () => {
    let deep: unknown = 'leaf'
    for (let index = 0; index < 200; index += 1) deep = { deep }
    expect(() => canonicalize(deep)).toThrow(/nesting/i)
  })

  it('escapes strings so structure cannot be forged through content', () => {
    expect(canonicalize({ 'a"b': 'c\nd' })).toBe('{"a\\"b":"c\\nd"}')
  })

  it('round-trips through canonicalValue with sorted keys', () => {
    expect(Object.keys(canonicalValue({ b: 1, a: { d: 1, c: 2 } }))).toEqual(['a', 'b'])
  })

  it('compares structurally with canonicalEquals', () => {
    expect(canonicalEquals({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true)
    expect(canonicalEquals({ a: 1 }, { a: '1' })).toBe(false)
    expect(canonicalEquals([1, 2], [2, 1])).toBe(false)
  })
})

describe('hashCanonical', () => {
  it('is stable across differently ordered but equal objects', () => {
    expect(hashCanonical({ a: 1, b: 2 })).toBe(hashCanonical({ b: 2, a: 1 }))
  })

  it('changes when any value changes', () => {
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }))
  })

  it('produces the sha256:<64 hex> shape', () => {
    const hash = hashCanonical({ a: 1 })
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(isHash(hash)).toBe(true)
    expect(isHash('sha256:nope')).toBe(false)
  })

  it('is reproducible across processes for a known input', () => {
    // Pinned so an accidental change to the canonical form is caught here.
    expect(hashCanonical({})).toBe(
      'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    )
  })
})

describe('hash helpers', () => {
  it('shortens prefixed and unprefixed hashes consistently', () => {
    expect(shortHash('sha256:abcdef0123456789', 6)).toBe('abcdef')
    expect(shortHash('abcdef0123456789', 6)).toBe('abcdef')
  })

  it('compares hashes without leaking length through early exit', () => {
    expect(hashEquals('sha256:aa', 'sha256:aa')).toBe(true)
    expect(hashEquals('sha256:aa', 'sha256:ab')).toBe(false)
    expect(hashEquals('sha256:aa', 'sha256:aaa')).toBe(false)
  })
})
