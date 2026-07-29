import {
  REDACTED,
  redactSensitiveData,
  type CurrentState,
  type DSPPlan,
  type FieldDiff,
  type PlanChange,
  type ResourceTypeDefinition,
} from '@dsp/protocol'

/**
 * Removes sensitive attribute values from a plan before it leaves the runtime.
 *
 * The *stored* plan keeps real values — apply needs them and the plan hash must
 * cover the actual intent. Redaction happens at the boundary: HTTP responses,
 * audit metadata, logs and CLI output.
 */
export function redactPlanForOutput(
  plan: DSPPlan,
  resourceTypes: ReadonlyMap<string, ResourceTypeDefinition>,
): DSPPlan {
  return {
    ...plan,
    changes: plan.changes.map((change) => redactChange(change, resourceTypes)),
  }
}

export function redactChange(
  change: PlanChange,
  resourceTypes: ReadonlyMap<string, ResourceTypeDefinition>,
): PlanChange {
  const sensitive = resourceTypes.get(change.resourceType)?.sensitiveFields ?? []
  const redact = (value: unknown): unknown => redactSensitiveData(value, { paths: sensitive })

  const out: PlanChange = {
    ...change,
    fields: change.fields.map((field) => redactField(field, sensitive)),
  }
  if ('before' in change) out.before = redact(change.before)
  if ('after' in change) out.after = redact(change.after)
  return out
}

function redactField(field: FieldDiff, sensitive: readonly string[]): FieldDiff {
  const isSensitive = sensitive.some((pattern) => pathCovered(field.path, pattern))
  if (!isSensitive) {
    return {
      ...field,
      before: redactSensitiveData(field.before),
      after: redactSensitiveData(field.after),
    }
  }
  return { ...field, before: REDACTED, after: REDACTED }
}

function pathCovered(path: string, pattern: string): boolean {
  const normalize = (value: string): string => value.replace(/\[\d+\]/g, '[]')
  const normalizedPath = normalize(path)
  const normalizedPattern = normalize(pattern)
  return (
    normalizedPath === normalizedPattern ||
    normalizedPath.startsWith(`${normalizedPattern}.`) ||
    normalizedPath.startsWith(`${normalizedPattern}[`)
  )
}

/**
 * Inspected state is provider-shaped, so only the generic key- and
 * pattern-based rules apply. Providers that expose credentials in their state
 * MUST declare them as sensitive fields.
 */
export function redactCurrentStateForOutput(state: CurrentState): CurrentState {
  return {
    ...state,
    state: redactSensitiveData(state.state) as CurrentState['state'],
  }
}
