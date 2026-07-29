import {
  DSPError,
  canonicalValue,
  hashCanonical,
  type DesiredStateDocument,
  type ResourceInstance,
  type ResourceProjection,
} from '@dsp/protocol'

export interface NormalizedResource {
  resourceType: string
  key: string
  attributes: Record<string, unknown>
  dependsOn: string[]
  externalId: string | null
}

export interface NormalizedProjection {
  /** Resources sorted by key, so any iteration order is deterministic. */
  resources: NormalizedResource[]
  byKey: Map<string, NormalizedResource>
  hash: string
}

/**
 * Canonicalizes a projection: sorts resources by key, sorts every object key
 * inside the attributes, and rejects duplicate resource keys.
 */
export function normalizeProjection(projection: ResourceProjection): NormalizedProjection {
  const seen = new Set<string>()
  const resources = projection.resources.map((resource) => {
    if (seen.has(resource.key)) {
      throw new DSPError(
        'VALIDATION_FAILED',
        `Duplicate resource key "${resource.key}" in projection`,
        { details: { resourceKey: resource.key, resourceType: resource.resourceType } },
      )
    }
    seen.add(resource.key)
    return normalizeResource(resource)
  })

  resources.sort((a, b) => compareStrings(a.key, b.key))

  return {
    resources,
    byKey: new Map(resources.map((resource) => [resource.key, resource])),
    hash: hashCanonical(
      resources.map((resource) => ({
        resourceType: resource.resourceType,
        key: resource.key,
        attributes: resource.attributes,
        dependsOn: resource.dependsOn,
      })),
    ),
  }
}

function normalizeResource(resource: ResourceInstance): NormalizedResource {
  return {
    resourceType: resource.resourceType,
    key: resource.key,
    attributes: canonicalValue(resource.attributes ?? {}),
    dependsOn: [...(resource.dependsOn ?? [])].sort(compareStrings),
    externalId: resource.externalId ?? null,
  }
}

/**
 * Hash of the desired document. `metadata.requestId` is excluded on purpose: it
 * is a correlation id, not part of the desired state, and including it would
 * make plans non-deterministic across otherwise identical requests.
 */
export function desiredStateHash(document: DesiredStateDocument): string {
  const { requestId: _requestId, ...metadata } = document.metadata
  return hashCanonical({
    apiVersion: document.apiVersion,
    kind: document.kind,
    metadata,
    spec: document.spec,
  })
}

export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
