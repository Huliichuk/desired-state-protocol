import {
  REDACTED,
  canonicalEquals,
  flattenValue,
  pathMatchesAny,
  type ResourceProjection,
  type ResourceTypeDefinition,
  type VerificationMismatch,
  type VerificationResult,
  type VerificationStatus,
} from '@dsp/protocol'
import { compareStrings, normalizeProjection } from '@dsp/plan-engine'

export interface VerifyInput {
  operationId: string
  desiredProjection: ResourceProjection
  observedProjection: ResourceProjection
  resourceTypes: ReadonlyMap<string, ResourceTypeDefinition>
  now: Date
}

/**
 * Verification re-reads the world and compares it, leaf by leaf, with what the
 * caller asked for. It never trusts the plan or the execution result: a change
 * reported as succeeded is only believed once the provider's own state agrees.
 *
 * Only desired attributes are checked. Extra attributes in the observed state
 * are not violations: DSP describes the state it owns, not the whole system.
 */
export function verifyDesiredState(input: VerifyInput): VerificationResult {
  const desired = normalizeProjection(input.desiredProjection)
  const observed = normalizeProjection(input.observedProjection)

  const matched: string[] = []
  const unmatched: VerificationMismatch[] = []

  for (const resource of desired.resources) {
    const definition = input.resourceTypes.get(resource.resourceType)
    const sensitive = definition?.sensitiveFields ?? []
    const actual = observed.byKey.get(resource.key)
    const desiredLeaves = flattenValue(resource.attributes)

    if (actual === undefined) {
      for (const [path] of desiredLeaves) {
        unmatched.push({
          path: `${resource.key}.${path}`,
          reason: `${resource.resourceType} "${resource.key}" was not found in the provider state`,
        })
      }
      continue
    }

    const actualLeaves = flattenValue(actual.attributes)
    for (const [path, expected] of desiredLeaves) {
      const fullPath = `${resource.key}.${path}`
      const found = actualLeaves.get(path)
      if (canonicalEquals(expected ?? null, found ?? null)) {
        matched.push(fullPath)
        continue
      }
      const isSensitive = pathMatchesAny(path, sensitive)
      unmatched.push({
        path: fullPath,
        reason: 'Observed value differs from the desired value',
        expected: isSensitive ? REDACTED : (expected ?? null),
        actual: isSensitive ? REDACTED : (found ?? null),
      })
    }
  }

  matched.sort(compareStrings)
  unmatched.sort((a, b) => compareStrings(a.path, b.path))

  const total = matched.length + unmatched.length
  const satisfaction = total === 0 ? 1 : round4(matched.length / total)

  return {
    operationId: input.operationId,
    status: statusFor(satisfaction, matched.length),
    satisfaction,
    verifiedAt: input.now.toISOString(),
    matched,
    unmatched,
  }
}

function statusFor(satisfaction: number, matchedCount: number): VerificationStatus {
  if (satisfaction >= 1) return 'satisfied'
  if (matchedCount === 0) return 'not_satisfied'
  return 'partially_satisfied'
}

export function verificationFailed(
  operationId: string,
  reason: string,
  now: Date,
): VerificationResult {
  return {
    operationId,
    status: 'verification_failed',
    satisfaction: 0,
    verifiedAt: now.toISOString(),
    matched: [],
    unmatched: [{ path: '', reason }],
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
