import { describe, expect, it } from 'vitest'
import { DSPError } from '@dsp/protocol'
import { findCycle, topologicalOrder } from '@dsp/plan-engine'

interface Node {
  id: string
  dependencies: string[]
}

const byId = (a: Node, b: Node): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const node = (id: string, ...dependencies: string[]): Node => ({ id, dependencies })

describe('topologicalOrder', () => {
  it('places every dependency before the node that needs it', () => {
    const ordered = topologicalOrder([node('c', 'b'), node('a'), node('b', 'a')], byId)
    expect(ordered.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('is deterministic for independent nodes, whatever the input order', () => {
    const nodes = [node('c'), node('a'), node('b')]
    const first = topologicalOrder(nodes, byId).map((item) => item.id)
    const shuffled = topologicalOrder([...nodes].reverse(), byId).map((item) => item.id)
    expect(first).toEqual(['a', 'b', 'c'])
    expect(shuffled).toEqual(first)
  })

  it('re-applies the tie-break as nodes become ready', () => {
    // Both `b` and `c` become ready only after `a`; the tie-break decides.
    const ordered = topologicalOrder([node('c', 'a'), node('b', 'a'), node('a')], byId)
    expect(ordered.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('ignores dependencies that point outside the graph', () => {
    const ordered = topologicalOrder([node('a', 'not-in-graph')], byId)
    expect(ordered.map((item) => item.id)).toEqual(['a'])
  })

  it('handles an empty graph', () => {
    expect(topologicalOrder([], byId)).toEqual([])
  })

  it('keeps a diamond consistent', () => {
    const ordered = topologicalOrder(
      [node('d', 'b', 'c'), node('b', 'a'), node('c', 'a'), node('a')],
      byId,
    ).map((item) => item.id)
    expect(ordered.indexOf('a')).toBeLessThan(ordered.indexOf('b'))
    expect(ordered.indexOf('b')).toBeLessThan(ordered.indexOf('d'))
    expect(ordered.indexOf('c')).toBeLessThan(ordered.indexOf('d'))
  })

  it('refuses a cycle and names the resources at fault', () => {
    const nodes = [node('a', 'b'), node('b', 'a')]
    expect(() => topologicalOrder(nodes, byId)).toThrow(DSPError)

    try {
      topologicalOrder(nodes, byId)
      expect.unreachable('a cycle must not be orderable')
    } catch (error) {
      expect(DSPError.isDSPError(error)).toBe(true)
      if (!DSPError.isDSPError(error)) return
      expect(error.code).toBe('DEPENDENCY_CYCLE_DETECTED')
      expect(error.details?.['cycle']).toEqual(['a', 'b', 'a'])
    }
  })

  it('detects a self-dependency', () => {
    expect(() => topologicalOrder([node('a', 'a')], byId)).toThrow(/cycle/)
  })

  it('detects a cycle even when part of the graph is orderable', () => {
    expect(() => topologicalOrder([node('ok'), node('a', 'b'), node('b', 'a')], byId)).toThrow(
      /cycle/,
    )
  })
})

describe('findCycle', () => {
  it('returns a closed walk for a cyclic graph', () => {
    expect(findCycle([node('a', 'b'), node('b', 'c'), node('c', 'a')])).toEqual([
      'a',
      'b',
      'c',
      'a',
    ])
  })

  it('returns nothing for an acyclic graph', () => {
    expect(findCycle([node('a'), node('b', 'a')])).toEqual([])
  })
})
