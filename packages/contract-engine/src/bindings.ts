import { celList, celMap } from '@bufbuild/cel'
import type { CelInput } from '@bufbuild/cel'
import type { ContractBindings, ResourceProjection } from '@dsp/protocol'

export function bindingsFromProjection(projection: ResourceProjection): ContractBindings {
  return {
    resources: projection.resources.map((resource) => ({
      type: resource.resourceType,
      key: resource.key,
      attributes: resource.attributes,
    })),
  }
}

/**
 * CEL needs its own map and list wrappers; plain objects are not addressable.
 */
export function toCelInput(value: unknown): CelInput {
  if (Array.isArray(value)) return celList(value.map(toCelInput))
  if (value instanceof Date) return value.toISOString()
  if (value !== null && typeof value === 'object') {
    return celMap(
      new Map(
        Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, toCelInput(item)]),
      ),
    )
  }
  // CEL has no undefined; a missing attribute is simply absent from the map.
  return (value ?? null) as CelInput
}

export function celBindings(bindings: ContractBindings): Record<string, CelInput> {
  return { resources: toCelInput(bindings.resources) }
}
