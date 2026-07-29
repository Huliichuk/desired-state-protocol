import {
  DSPError,
  DSP_API_VERSION,
  canonicalEquals,
  documentNamespace,
  hashCanonical,
  planIdFromHash,
  type ChangeAction,
  type DSPPlan,
  type DesiredStateDocument,
  type PlanChange,
  type PlanHashInput,
  type PlanSummary,
  type ContractCheck,
  type PolicyEvaluationResult,
  type ProtocolLimits,
  type ResourceProjection,
  type ResourceTypeDefinition,
} from '@dsp/protocol'
import { assertChangeLimit, computeChanges, type DiffOptions } from './diff.js'
import { topologicalOrder } from './graph.js'
import { compareStrings, desiredStateHash, normalizeProjection } from './normalize.js'
import { scorePlan, withChangeRisk, type PlanRisk, type RiskContext } from './risk.js'

export interface PolicyEvaluationInput {
  changes: PlanChange[]
  risk: PlanRisk
}

export interface BuildPlanInput {
  desired: DesiredStateDocument
  desiredProjection: ResourceProjection
  currentProjection: ResourceProjection
  currentRevision: string | null
  resourceTypes: ReadonlyMap<string, ResourceTypeDefinition>
  provider: string
  environment: string
  policyBundleHash: string
  /** Injected so the plan engine stays independent of the policy engine. */
  evaluatePolicies: (input: PolicyEvaluationInput) => PolicyEvaluationResult
  /**
   * The client's own constraints, already evaluated against the desired state.
   * Passed in rather than computed here so the plan engine stays independent of the
   * expression language, and so the result is a plain input to the hash.
   */
  contract?: ContractCheck | null
  /**
   * Optional provider hook, applied after the diff and before risk scoring.
   * It may only annotate existing changes: adding, removing or re-typing a
   * change is rejected, so a provider can never widen a plan behind the
   * runtime's back.
   */
  refineChanges?: (changes: PlanChange[]) => Promise<PlanChange[]>
  limits: ProtocolLimits
  now: Date
  options: DiffOptions
}

const ACTION_RANK: Record<ChangeAction, number> = {
  create: 0,
  update: 1,
  replace: 2,
  delete: 3,
  noop: 4,
  blocked: 5,
}

/**
 * Builds an immutable plan.
 *
 * `buildPlan` is a pure function: with the same desired state, current state,
 * resource types, policy bundle and options it returns a byte-identical plan
 * apart from `metadata.createdAt` / `metadata.expiresAt`. `metadata.planHash`
 * and `metadata.id` are derived only from the deterministic part.
 */
export async function buildPlan(input: BuildPlanInput): Promise<DSPPlan> {
  const desired = normalizeProjection(input.desiredProjection)
  const current = normalizeProjection(input.currentProjection)

  const riskContext: RiskContext = {
    environment: input.environment,
    resourceTypes: input.resourceTypes,
  }

  const rawChanges = computeChanges({
    desired,
    current,
    resourceTypes: input.resourceTypes,
    options: input.options,
  })
  assertChangeLimit(rawChanges, input.limits.maxChanges)

  const ordered = topologicalOrder(rawChanges, compareChanges)
  const refined =
    input.refineChanges === undefined
      ? ordered
      : assertRefinement(ordered, await input.refineChanges(ordered))

  const changes = withChangeRisk(refined, riskContext)

  const risk = scorePlan(changes, riskContext)
  const policyEvaluation = input.evaluatePolicies({ changes, risk })
  const summary = summarize(changes, risk)

  const approvals = {
    required: policyEvaluation.requiredApprovals.length > 0,
    requirements: policyEvaluation.requiredApprovals,
  }
  const contract = input.contract ?? null
  // A document whose own declared constraints do not hold is internally
  // contradictory, so it is not executable. This is the client catching its own
  // mistake; the operator's control is the policy bundle.
  const executable = policyEvaluation.allowed && (contract?.satisfied ?? true)

  const hashInput: PlanHashInput = {
    apiVersion: DSP_API_VERSION,
    kind: 'Plan',
    desiredStateHash: desiredStateHash(input.desired),
    currentStateHash: current.hash,
    policyBundleHash: input.policyBundleHash,
    summary,
    changes,
    approvals,
    policyEvaluation,
    contract,
    executable,
  }
  const planHash = hashCanonical(hashInput)

  return {
    apiVersion: DSP_API_VERSION,
    kind: 'Plan',
    metadata: {
      id: planIdFromHash(planHash),
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + input.limits.planTtlSeconds * 1000).toISOString(),
      desiredStateHash: hashInput.desiredStateHash,
      currentStateHash: hashInput.currentStateHash,
      policyBundleHash: input.policyBundleHash,
      planHash,
      kind: input.desired.kind,
      namespace: documentNamespace(input.desired),
      resourceName: input.desired.metadata.name,
      provider: input.provider,
      currentRevision: input.currentRevision,
    },
    summary,
    changes,
    approvals,
    policyEvaluation,
    contract,
    executable,
  }
}

/**
 * Recomputes the hash of an existing plan. Used before apply so that a stored
 * or transported plan cannot be tampered with.
 */
export function computePlanHash(plan: DSPPlan): string {
  const hashInput: PlanHashInput = {
    apiVersion: plan.apiVersion,
    kind: plan.kind,
    desiredStateHash: plan.metadata.desiredStateHash,
    currentStateHash: plan.metadata.currentStateHash,
    policyBundleHash: plan.metadata.policyBundleHash,
    summary: plan.summary,
    changes: plan.changes,
    approvals: plan.approvals,
    policyEvaluation: plan.policyEvaluation,
    contract: plan.contract,
    executable: plan.executable,
  }
  return hashCanonical(hashInput)
}

export function isPlanExpired(plan: DSPPlan, now: Date): boolean {
  return Date.parse(plan.metadata.expiresAt) <= now.getTime()
}

function summarize(changes: readonly PlanChange[], risk: PlanRisk): PlanSummary {
  const counts: Record<ChangeAction, number> = {
    create: 0,
    update: 0,
    delete: 0,
    replace: 0,
    noop: 0,
    blocked: 0,
  }
  for (const change of changes) counts[change.action] += 1

  return {
    create: counts.create,
    update: counts.update,
    delete: counts.delete,
    replace: counts.replace,
    noop: counts.noop,
    blocked: counts.blocked,
    risk: risk.level,
    riskScore: risk.score,
  }
}

/**
 * A provider refinement is only allowed to change advisory fields. Anything
 * that could widen the blast radius — the set of changes, their actions, their
 * targets or their ordering constraints — is rejected.
 */
export function assertRefinement(
  original: readonly PlanChange[],
  refined: readonly PlanChange[],
): PlanChange[] {
  if (refined.length !== original.length) {
    throw new DSPError(
      'PROVIDER_ERROR',
      `Provider refinement returned ${refined.length} changes, expected ${original.length}`,
    )
  }

  return original.map((change, index) => {
    const candidate = refined[index]
    if (candidate === undefined) {
      throw new DSPError('PROVIDER_ERROR', `Provider refinement dropped change ${change.id}`)
    }
    if (
      candidate.id !== change.id ||
      candidate.action !== change.action ||
      candidate.resourceType !== change.resourceType ||
      candidate.resourceKey !== change.resourceKey ||
      !canonicalEquals(candidate.dependencies, change.dependencies) ||
      // `before` / `after` are absent on create and delete changes; canonical
      // JSON has no representation for `undefined`, so normalize to null first.
      !canonicalEquals(candidate.after ?? null, change.after ?? null) ||
      !canonicalEquals(candidate.before ?? null, change.before ?? null)
    ) {
      throw new DSPError(
        'PROVIDER_ERROR',
        `Provider refinement altered protected fields of change ${change.id}`,
        { details: { changeId: change.id } },
      )
    }
    return candidate
  })
}

function compareChanges(a: PlanChange, b: PlanChange): number {
  const byAction = ACTION_RANK[a.action] - ACTION_RANK[b.action]
  if (byAction !== 0) return byAction
  const byType = compareStrings(a.resourceType, b.resourceType)
  if (byType !== 0) return byType
  return compareStrings(a.resourceKey, b.resourceKey)
}
