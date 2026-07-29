import {
  pathMatchesAny,
  type PlanChange,
  type ResourceTypeDefinition,
  type RiskLevel,
} from '@dsp/protocol'

/**
 * Deterministic risk weights. No model, no heuristics that change between runs:
 * the same plan always scores the same, which is what makes risk-based policy
 * enforceable.
 */
export const RISK_WEIGHTS = {
  destructiveDelete: 45,
  destructiveReplace: 35,
  irreversible: 10,
  environmentProduction: 20,
  environmentStaging: 8,
  sensitiveField: 15,
  financial: 15,
  permissionScope: 15,
  externallyVisible: 5,
} as const

const PRODUCTION_ENVIRONMENTS = new Set(['production', 'prod', 'live'])
const STAGING_ENVIRONMENTS = new Set(['staging', 'stage', 'preprod', 'pre-production'])

export interface RiskContext {
  environment: string
  resourceTypes: ReadonlyMap<string, ResourceTypeDefinition>
}

/**
 * Score of a single change, excluding blast radius (a single change has a blast
 * radius of one). Range 0..100.
 */
export function scoreChange(change: PlanChange, context: RiskContext): number {
  if (change.action === 'noop' || change.action === 'blocked') return 0

  const definition = context.resourceTypes.get(change.resourceType)
  const factors = definition?.riskFactors ?? {}

  let score = 0
  if (change.action === 'delete') score += RISK_WEIGHTS.destructiveDelete
  if (change.action === 'replace') score += RISK_WEIGHTS.destructiveReplace
  if (!change.reversible) score += RISK_WEIGHTS.irreversible
  score += environmentWeight(context.environment)

  const touchesSensitive =
    factors.sensitive === true ||
    change.fields.some((field) => pathMatchesAny(field.path, definition?.sensitiveFields ?? []))
  if (touchesSensitive) score += RISK_WEIGHTS.sensitiveField
  if (factors.financial === true) score += RISK_WEIGHTS.financial
  if (factors.permissionScope === true) score += RISK_WEIGHTS.permissionScope
  if (factors.externallyVisible === true) score += RISK_WEIGHTS.externallyVisible

  return clamp(score)
}

export function environmentWeight(environment: string): number {
  const normalized = environment.trim().toLowerCase()
  if (PRODUCTION_ENVIRONMENTS.has(normalized)) return RISK_WEIGHTS.environmentProduction
  if (STAGING_ENVIRONMENTS.has(normalized)) return RISK_WEIGHTS.environmentStaging
  return 0
}

/**
 * Blast radius: how much of the system a single apply touches.
 */
export function blastRadiusWeight(effectiveChanges: number): number {
  if (effectiveChanges <= 1) return 0
  if (effectiveChanges <= 5) return 6
  if (effectiveChanges <= 20) return 12
  return 20
}

export function riskLevelFromScore(score: number): RiskLevel {
  if (score >= 80) return 'critical'
  if (score >= 50) return 'high'
  if (score >= 20) return 'medium'
  return 'low'
}

export interface PlanRisk {
  score: number
  level: RiskLevel
}

/**
 * Plan-level risk: the riskiest single change plus the blast radius of the plan
 * as a whole.
 */
export function scorePlan(changes: readonly PlanChange[], context: RiskContext): PlanRisk {
  const effective = changes.filter(
    (change) => change.action !== 'noop' && change.action !== 'blocked',
  )
  const maxChangeScore = effective.reduce(
    (max, change) => Math.max(max, scoreChange(change, context)),
    0,
  )
  const score = clamp(maxChangeScore + blastRadiusWeight(effective.length))
  return { score, level: riskLevelFromScore(score) }
}

/**
 * Returns the changes with `estimatedRisk` filled in.
 */
export function withChangeRisk(changes: readonly PlanChange[], context: RiskContext): PlanChange[] {
  return changes.map((change) => ({
    ...change,
    estimatedRisk: riskLevelFromScore(scoreChange(change, context)),
  }))
}

function clamp(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)))
}
