import type { DSPErrorCode } from '@dsp/protocol'

/**
 * Stable exit codes so DSP can be used from CI without parsing output.
 */
export const EXIT = {
  ok: 0,
  error: 1,
  invalidDocument: 2,
  approvalRequired: 3,
  policyDenied: 4,
  stateDrift: 5,
  notSatisfied: 6,
  planExpired: 7,
  notConfirmed: 8,
  auditChainBroken: 9,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

const BY_CODE: Partial<Record<DSPErrorCode, ExitCode>> = {
  VALIDATION_FAILED: EXIT.invalidDocument,
  SCHEMA_VALIDATION_FAILED: EXIT.invalidDocument,
  IMMUTABLE_FIELD_CHANGED: EXIT.invalidDocument,
  UNKNOWN_KIND: EXIT.invalidDocument,
  UNKNOWN_RESOURCE_TYPE: EXIT.invalidDocument,
  APPROVAL_REQUIRED: EXIT.approvalRequired,
  APPROVAL_INVALID: EXIT.approvalRequired,
  POLICY_DENIED: EXIT.policyDenied,
  CONTRACT_VIOLATED: EXIT.policyDenied,
  CONTRACT_PREDICATE_INVALID: EXIT.invalidDocument,
  DESTRUCTIVE_ACTION_BLOCKED: EXIT.policyDenied,
  STATE_DRIFT_DETECTED: EXIT.stateDrift,
  PLAN_EXPIRED: EXIT.planExpired,
  VERIFICATION_FAILED: EXIT.notSatisfied,
}

export function exitCodeFor(code: DSPErrorCode | string): ExitCode {
  return BY_CODE[code as DSPErrorCode] ?? EXIT.error
}
