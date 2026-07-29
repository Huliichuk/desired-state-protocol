import type { Actor } from './common.js'
import type { DSPErrorPayload } from './errors.js'
import type { ChangeAction } from './plan.js'
import type { VerificationResult } from './verification.js'

export type ChangeStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'blocked' | 'compensated'

export type OperationStatus =
  | 'created'
  | 'running'
  | 'partially_completed'
  | 'completed'
  | 'failed'
  | 'verification_failed'
  /**
   * Every change succeeded and the world matches the document, but the client's
   * own success conditions do not hold. The mechanism worked and the point was
   * missed, which is worth its own status rather than being reported as success.
   */
  | 'goal_not_satisfied'
  | 'cancelled'

export const TERMINAL_OPERATION_STATUSES: readonly OperationStatus[] = [
  'partially_completed',
  'completed',
  'failed',
  'verification_failed',
  'goal_not_satisfied',
  'cancelled',
] as const

export interface ChangeExecutionRecord {
  changeId: string
  resourceType: string
  resourceKey: string
  action: ChangeAction
  status: ChangeStatus
  attempts: number
  startedAt?: string
  finishedAt?: string
  externalId?: string | null
  providerRequestId?: string | null
  error?: DSPErrorPayload | null
}

export interface OperationRecord {
  id: string
  tenant: string
  planId: string
  planHash: string
  idempotencyKey: string
  status: OperationStatus
  actor: Actor
  createdAt: string
  updatedAt: string
  changes: ChangeExecutionRecord[]
  verification: VerificationResult | null
  cancellationRequested: boolean
  error: DSPErrorPayload | null
}

export interface ChangeExecutionResult {
  externalId?: string | null
  providerRequestId?: string | null
  /** Attributes as observed right after the change was applied. */
  observed?: Record<string, unknown>
}
