import type { ContractCheck } from './contract.js'

export type VerificationStatus =
  'satisfied' | 'partially_satisfied' | 'not_satisfied' | 'verification_failed'

export interface VerificationMismatch {
  path: string
  reason: string
  expected?: unknown
  actual?: unknown
}

export interface VerificationResult {
  operationId: string
  status: VerificationStatus
  /** Fraction of checked paths that matched, in [0, 1], rounded to 4 decimals. */
  satisfaction: number
  verifiedAt: string
  matched: string[]
  unmatched: VerificationMismatch[]
  /**
   * The client's success conditions, evaluated against the state the provider
   * actually reports. Null when the document declared none — in which case DSP can
   * only report structural agreement, which is where it stood before contracts.
   */
  contract: ContractCheck | null
}
