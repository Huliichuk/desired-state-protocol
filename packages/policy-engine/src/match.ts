import {
  pathMatchesAny,
  type PlanChange,
  type PolicyEvaluationContext,
  type PolicyRuleCondition,
} from '@dsp/protocol'

function toArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}

/**
 * Resource type patterns support a trailing `*`: `stripe.*` matches every
 * Stripe resource type.
 */
export function resourceTypeMatches(resourceType: string, pattern: string): boolean {
  if (pattern.endsWith('*')) return resourceType.startsWith(pattern.slice(0, -1))
  return resourceType === pattern
}

/**
 * True when the rule's scope covers the current document and environment.
 * A rule outside its scope never fires, regardless of the changes.
 */
export function conditionMatchesContext(
  condition: PolicyRuleCondition | undefined,
  context: PolicyEvaluationContext,
): boolean {
  if (condition === undefined) return true

  const environments = toArray(condition.environment)
  if (environments !== undefined && !environments.includes(context.environment)) return false

  const kinds = toArray(condition.kind)
  if (kinds !== undefined && !kinds.includes(context.kind)) return false

  return true
}

export function conditionMatchesChange(
  condition: PolicyRuleCondition | undefined,
  change: PlanChange,
): boolean {
  if (condition === undefined) return true

  const actions = toArray(condition.action)
  if (actions !== undefined && !actions.includes(change.action)) return false

  const resourceTypes = toArray(condition.resourceType)
  if (
    resourceTypes !== undefined &&
    !resourceTypes.some((pattern) => resourceTypeMatches(change.resourceType, pattern))
  ) {
    return false
  }

  if (condition.riskIn !== undefined && !condition.riskIn.includes(change.estimatedRisk)) {
    return false
  }

  if (condition.destructive !== undefined && condition.destructive !== change.destructive) {
    return false
  }

  if (condition.pathPrefix !== undefined) {
    const touched = change.fields.map((field) => field.path)
    const paths = touched.length > 0 ? touched : ['']
    if (!paths.some((path) => pathMatchesAny(path, condition.pathPrefix ?? []))) return false
  }

  return true
}

/**
 * Changes that policies evaluate over. `noop` and `blocked` changes never reach
 * the external system, so they are out of scope for policy decisions.
 */
export function effectiveChanges(changes: readonly PlanChange[]): PlanChange[] {
  return changes.filter((change) => change.action !== 'noop' && change.action !== 'blocked')
}
