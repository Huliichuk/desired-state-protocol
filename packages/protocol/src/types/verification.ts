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
}
