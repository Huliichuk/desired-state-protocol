import type { JsonSchema } from '../types/common.js'
import { desiredStateSchema, secretReferenceSchema } from './desired-state.schema.js'
import { manifestSchema } from './manifest.schema.js'
import { planSchema } from './plan.schema.js'
import { policySchema } from './policy.schema.js'
import { resultSchema } from './result.schema.js'

export { desiredStateSchema, secretReferenceSchema, manifestSchema, planSchema, policySchema, resultSchema }

/**
 * The published contract of DSP 0.1. `schemas/*.json` in the repository root is
 * generated from this map and MUST stay in sync (see `schemas.test.ts`).
 */
export const PROTOCOL_SCHEMAS: Readonly<Record<string, JsonSchema>> = Object.freeze({
  'manifest.schema.json': manifestSchema,
  'desired-state.schema.json': desiredStateSchema,
  'plan.schema.json': planSchema,
  'result.schema.json': resultSchema,
  'policy.schema.json': policySchema,
})
