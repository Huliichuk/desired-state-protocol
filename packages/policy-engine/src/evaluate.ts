import {
  approvalRequirementId,
  hashCanonical,
  maxRisk,
  type ApprovalRequirement,
  type PlanChange,
  type PolicyBundle,
  type PolicyDecision,
  type PolicyDocument,
  type PolicyEvaluationContext,
  type PolicyEvaluationResult,
  type PolicyRule,
  type RiskLevel,
} from '@dsp/protocol'
import { conditionMatchesChange, conditionMatchesContext, effectiveChanges } from './match.js'

export interface EvaluateInput {
  changes: readonly PlanChange[]
  risk: { score: number; level: RiskLevel }
  context: PolicyEvaluationContext
}

/**
 * Evaluates a policy bundle against a change set.
 *
 * Pure and total: no I/O, no clock, no model. The same bundle and the same
 * changes always yield the same decisions, which is what lets the policy bundle
 * hash be part of the plan hash.
 */
export function evaluatePolicies(
  bundle: PolicyBundle,
  input: EvaluateInput,
): PolicyEvaluationResult {
  const decisions: PolicyDecision[] = []
  const approvals = new Map<string, ApprovalRequirement>()
  const candidates = effectiveChanges(input.changes)
  let allowed = true

  for (const policy of sortedPolicies(bundle)) {
    for (const rule of policy.spec.rules) {
      const decision = evaluateRule(policy, rule, candidates, input)
      if (decision === null) continue

      decisions.push(decision)

      if (decision.effect === 'deny') allowed = false
      if (decision.effect === 'requireApproval') {
        const requirement = toApprovalRequirement(policy, rule, decision, candidates, input)
        approvals.set(requirement.id, requirement)
      }
    }
  }

  return {
    allowed,
    decisions,
    requiredApprovals: [...approvals.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
  }
}

function evaluateRule(
  policy: PolicyDocument,
  rule: PolicyRule,
  candidates: readonly PlanChange[],
  input: EvaluateInput,
): PolicyDecision | null {
  if (!conditionMatchesContext(rule.when, input.context)) return null

  const matched = candidates.filter((change) => conditionMatchesChange(rule.when, change))

  if (rule.constraints !== undefined) {
    const violation = constraintViolation(rule, matched, candidates)
    if (violation === null) return null
    return {
      policyId: policy.metadata.name,
      ruleId: rule.id,
      effect: rule.effect,
      changeIds: matched.map((change) => change.id),
      message: rule.message ?? violation,
    }
  }

  if (matched.length === 0) return null

  return {
    policyId: policy.metadata.name,
    ruleId: rule.id,
    effect: rule.effect,
    changeIds: matched.map((change) => change.id),
    message: rule.message ?? defaultMessage(rule, matched.length),
  }
}

function constraintViolation(
  rule: PolicyRule,
  matched: readonly PlanChange[],
  candidates: readonly PlanChange[],
): string | null {
  const { maxChanges, maxTotalChanges } = rule.constraints ?? {}

  if (maxChanges !== undefined && matched.length > maxChanges) {
    return `Rule "${rule.id}" allows at most ${maxChanges} matching change(s), plan has ${matched.length}`
  }
  if (maxTotalChanges !== undefined && candidates.length > maxTotalChanges) {
    return `Rule "${rule.id}" allows at most ${maxTotalChanges} change(s) in a plan, plan has ${candidates.length}`
  }
  return null
}

function defaultMessage(rule: PolicyRule, matchedCount: number): string {
  switch (rule.effect) {
    case 'deny':
      return `Rule "${rule.id}" denies ${matchedCount} change(s)`
    case 'requireApproval':
      return `Rule "${rule.id}" requires approval for ${matchedCount} change(s)`
    case 'warn':
      return `Rule "${rule.id}" flagged ${matchedCount} change(s)`
    case 'allow':
      return `Rule "${rule.id}" explicitly allows ${matchedCount} change(s)`
  }
}

function toApprovalRequirement(
  policy: PolicyDocument,
  rule: PolicyRule,
  decision: PolicyDecision,
  candidates: readonly PlanChange[],
  input: EvaluateInput,
): ApprovalRequirement {
  const matched = candidates.filter((change) => decision.changeIds.includes(change.id))
  const risk =
    matched.length > 0 ? maxRisk(matched.map((change) => change.estimatedRisk)) : input.risk.level

  return {
    id: approvalRequirementId(`${policy.metadata.name}/${rule.id}`),
    reason: decision.message,
    policyId: policy.metadata.name,
    ruleId: rule.id,
    minApprovals: rule.minApprovals ?? 1,
    risk,
  }
}

/**
 * Policies are evaluated in a stable, name-sorted order so the resulting
 * decision list — and therefore the plan hash — never depends on load order.
 */
export function sortedPolicies(bundle: PolicyBundle): PolicyDocument[] {
  return [...bundle.policies].sort((a, b) =>
    a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0,
  )
}

export function policyBundleHash(bundle: PolicyBundle): string {
  return hashCanonical(sortedPolicies(bundle))
}
