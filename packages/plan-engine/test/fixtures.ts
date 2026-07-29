import {
  DEFAULT_LIMITS,
  DSP_API_VERSION,
  type DesiredStateDocument,
  type PolicyEvaluationResult,
  type ResourceInstance,
  type ResourceProjection,
  type ResourceTypeDefinition,
} from '@dsp/protocol'
import type { BuildPlanInput } from '@dsp/plan-engine'

export const DB_TYPE = 'test.database'
export const TABLE_TYPE = 'test.table'
export const SUB_TYPE = 'test.subscription'
export const READONLY_TYPE = 'test.readonly'

export const resourceTypes: ReadonlyMap<string, ResourceTypeDefinition> = new Map(
  [
    {
      name: DB_TYPE,
      provider: 'test',
      capabilities: { inspect: true, plan: true, apply: true, verify: true, delete: true },
      identityFields: ['name'],
      immutableFields: ['engine'],
      sensitiveFields: [],
      attributeSchema: { type: 'object' },
    },
    {
      name: TABLE_TYPE,
      provider: 'test',
      capabilities: { inspect: true, plan: true, apply: true, verify: true, delete: false },
      identityFields: ['name'],
      immutableFields: ['columns[].type'],
      sensitiveFields: ['apiToken'],
      attributeSchema: { type: 'object' },
    },
    {
      name: SUB_TYPE,
      provider: 'test',
      capabilities: { inspect: true, plan: true, apply: true, verify: true, delete: true },
      identityFields: ['user'],
      immutableFields: ['currency'],
      sensitiveFields: [],
      riskFactors: { financial: true, externallyVisible: true },
      attributeSchema: { type: 'object' },
    },
    {
      name: READONLY_TYPE,
      provider: 'test',
      capabilities: { inspect: true, plan: true, apply: false, verify: true, delete: false },
      identityFields: ['name'],
      immutableFields: [],
      sensitiveFields: [],
      attributeSchema: { type: 'object' },
    },
  ].map((definition) => [definition.name, definition as ResourceTypeDefinition]),
)

export function resource(
  resourceType: string,
  key: string,
  attributes: Record<string, unknown>,
  dependsOn?: string[],
): ResourceInstance {
  return dependsOn === undefined
    ? { resourceType, key, attributes }
    : { resourceType, key, attributes, dependsOn }
}

export function projection(...resources: ResourceInstance[]): ResourceProjection {
  return { resources }
}

export const EMPTY: ResourceProjection = { resources: [] }

export function document(spec: unknown = {}): DesiredStateDocument {
  return {
    apiVersion: DSP_API_VERSION,
    kind: 'TestWorkspace',
    metadata: { name: 'fixture' },
    spec,
  }
}

export const ALLOW_ALL: PolicyEvaluationResult = {
  allowed: true,
  decisions: [],
  requiredApprovals: [],
}

export interface PlanInputOverrides {
  desired?: DesiredStateDocument
  desiredProjection?: ResourceProjection
  currentProjection?: ResourceProjection
  policyBundleHash?: string
  environment?: string
  now?: Date
  allowDelete?: boolean
  allowReplace?: boolean
  evaluatePolicies?: BuildPlanInput['evaluatePolicies']
  refineChanges?: BuildPlanInput['refineChanges']
}

export function planInput(overrides: PlanInputOverrides = {}): BuildPlanInput {
  const refine = overrides.refineChanges
  return {
    desired: overrides.desired ?? document(),
    desiredProjection: overrides.desiredProjection ?? EMPTY,
    currentProjection: overrides.currentProjection ?? EMPTY,
    currentRevision: null,
    resourceTypes,
    provider: 'test',
    environment: overrides.environment ?? 'test',
    policyBundleHash: overrides.policyBundleHash ?? 'sha256:' + 'a'.repeat(64),
    evaluatePolicies: overrides.evaluatePolicies ?? ((): PolicyEvaluationResult => ALLOW_ALL),
    ...(refine === undefined ? {} : { refineChanges: refine }),
    limits: DEFAULT_LIMITS,
    now: overrides.now ?? new Date('2026-07-29T18:00:00.000Z'),
    options: {
      allowDelete: overrides.allowDelete ?? false,
      allowReplace: overrides.allowReplace ?? false,
    },
  }
}
