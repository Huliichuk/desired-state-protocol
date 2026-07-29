import type { DspApiVersion } from '../version.js'
import type { RiskLevel } from './common.js'
import type { ChangeAction } from './plan.js'

export type PolicyEffect = 'allow' | 'deny' | 'warn' | 'requireApproval'

export interface PolicyRuleCondition {
  /** Matches changes with any of these actions. */
  action?: ChangeAction | ChangeAction[]
  /** Matches changes on any of these resource types. Supports a `*` suffix. */
  resourceType?: string | string[]
  /** Matches documents of any of these kinds. */
  kind?: string | string[]
  /** Matches changes whose estimated risk is in this set. */
  riskIn?: RiskLevel[]
  /** Matches changes flagged destructive. */
  destructive?: boolean
  /** Matches when the evaluated environment is in this set. */
  environment?: string | string[]
  /** Matches changes touching any field path with one of these prefixes. */
  pathPrefix?: string[]
}

export interface PolicyRuleConstraints {
  /** Maximum number of matching changes allowed in one plan. */
  maxChanges?: number
  /** Maximum number of changes allowed in the whole plan. */
  maxTotalChanges?: number
}

export interface PolicyRule {
  id: string
  description?: string
  when?: PolicyRuleCondition
  constraints?: PolicyRuleConstraints
  effect: PolicyEffect
  message?: string
  /** Number of approvals required when `effect` is `requireApproval`. */
  minApprovals?: number
}

export interface PolicyDocument {
  apiVersion: DspApiVersion
  kind: 'Policy'
  metadata: {
    name: string
    description?: string
  }
  spec: {
    rules: PolicyRule[]
  }
}

/**
 * The full, ordered set of policies a runtime evaluates. Hashed into every plan
 * so that a plan can never be applied under a different policy bundle.
 */
export interface PolicyBundle {
  policies: PolicyDocument[]
}

export interface PolicyEvaluationContext {
  environment: string
  kind: string
  namespace: string
  resourceName: string
}
