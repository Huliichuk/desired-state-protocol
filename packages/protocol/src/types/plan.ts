import type { DspApiVersion } from '../version.js'
import type { RiskLevel } from './common.js'
import type { PolicyEffect } from './policy.js'
import type { ContractCheck } from './contract.js'

export type ChangeAction = 'create' | 'update' | 'delete' | 'replace' | 'noop' | 'blocked'

export const CHANGE_ACTIONS: readonly ChangeAction[] = [
  'create',
  'update',
  'delete',
  'replace',
  'noop',
  'blocked',
] as const

export interface FieldDiff {
  path: string
  before: unknown
  after: unknown
  immutable: boolean
}

export interface PlanChange {
  id: string
  resourceType: string
  resourceKey: string
  action: ChangeAction
  /** Attribute path when the change is scoped to a single field. */
  path?: string
  before?: unknown
  after?: unknown
  /** Per-field breakdown for `update` and `replace` changes. */
  fields: FieldDiff[]
  reason: string
  reversible: boolean
  destructive: boolean
  /** Ids of changes that MUST succeed before this change runs. */
  dependencies: string[]
  estimatedRisk: RiskLevel
  /** Set when the action is `blocked`. */
  blockedBy?: string
}

export interface PlanSummary {
  create: number
  update: number
  delete: number
  replace: number
  noop: number
  blocked: number
  risk: RiskLevel
  riskScore: number
}

export interface ApprovalRequirement {
  id: string
  reason: string
  policyId?: string
  ruleId?: string
  minApprovals: number
  risk: RiskLevel
}

export interface PolicyDecision {
  policyId: string
  ruleId: string
  effect: PolicyEffect
  changeIds: string[]
  message: string
}

export interface PolicyEvaluationResult {
  allowed: boolean
  decisions: PolicyDecision[]
  requiredApprovals: ApprovalRequirement[]
}

export interface PlanMetadata {
  id: string
  createdAt: string
  expiresAt: string
  desiredStateHash: string
  currentStateHash: string
  policyBundleHash: string
  planHash: string
  kind: string
  namespace: string
  resourceName: string
  provider: string
  /** Revision observed while planning; re-checked before apply. */
  currentRevision: string | null
}

export interface PlanApprovals {
  required: boolean
  requirements: ApprovalRequirement[]
}

export interface DSPPlan {
  apiVersion: DspApiVersion
  kind: 'Plan'
  metadata: PlanMetadata
  summary: PlanSummary
  changes: PlanChange[]
  approvals: PlanApprovals
  policyEvaluation: PolicyEvaluationResult
  /**
   * The client's own declared constraints, evaluated against the desired state.
   * Null when the document declared none.
   */
  contract: ContractCheck | null
  executable: boolean
}

/**
 * The subset of a plan that determines its identity. Timestamps and the plan id
 * are deliberately excluded so that identical inputs produce an identical hash.
 */
export interface PlanHashInput {
  apiVersion: DspApiVersion
  kind: 'Plan'
  desiredStateHash: string
  currentStateHash: string
  policyBundleHash: string
  summary: PlanSummary
  changes: PlanChange[]
  approvals: PlanApprovals
  policyEvaluation: PolicyEvaluationResult
  contract: ContractCheck | null
  executable: boolean
}

export interface ApprovalRecord {
  planId: string
  planHash: string
  approvedBy: string
  approvedAt: string
  reason: string
  requirementIds: string[]
}
