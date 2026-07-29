import { DSPError } from '@dsp/protocol'

export interface GraphNode {
  id: string
  dependencies: string[]
}

/**
 * Kahn's algorithm with a deterministic tie-break: whenever several nodes are
 * ready, the one that sorts first under `compare` runs first. Two runs over the
 * same input therefore always produce the same order.
 */
export function topologicalOrder<T extends GraphNode>(
  nodes: readonly T[],
  compare: (a: T, b: T) => number,
): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const node of nodes) {
    // Dependencies pointing outside the graph are ignored: they refer to
    // resources that are not part of this plan.
    const deps = node.dependencies.filter((dependency) => byId.has(dependency))
    indegree.set(node.id, deps.length)
    for (const dependency of deps) {
      const list = dependents.get(dependency)
      if (list === undefined) dependents.set(dependency, [node.id])
      else list.push(node.id)
    }
  }

  const ready = nodes.filter((node) => indegree.get(node.id) === 0).sort(compare)
  const ordered: T[] = []

  while (ready.length > 0) {
    const node = ready.shift() as T
    ordered.push(node)

    let dirty = false
    for (const dependentId of dependents.get(node.id) ?? []) {
      const remaining = (indegree.get(dependentId) ?? 0) - 1
      indegree.set(dependentId, remaining)
      if (remaining === 0) {
        const dependent = byId.get(dependentId)
        if (dependent !== undefined) {
          ready.push(dependent)
          dirty = true
        }
      }
    }
    if (dirty) ready.sort(compare)
  }

  if (ordered.length !== nodes.length) {
    const cycle = findCycle(nodes)
    throw new DSPError(
      'DEPENDENCY_CYCLE_DETECTED',
      `Resource dependencies form a cycle: ${cycle.join(' -> ')}`,
      { details: { cycle } },
    )
  }

  return ordered
}

/**
 * Returns one concrete cycle, so the error message can name the resources that
 * are actually at fault instead of dumping the whole graph.
 */
export function findCycle<T extends GraphNode>(nodes: readonly T[]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (id: string): string[] | null => {
    const current = state.get(id)
    if (current === 'done') return null
    if (current === 'visiting') {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }

    state.set(id, 'visiting')
    stack.push(id)
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (!byId.has(dependency)) continue
      const cycle = visit(dependency)
      if (cycle !== null) return cycle
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }

  for (const node of nodes) {
    const cycle = visit(node.id)
    if (cycle !== null) return cycle
  }
  return []
}
