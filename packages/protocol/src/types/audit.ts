import type { Actor } from './common.js'

export type AuditOutcome = 'success' | 'failure' | 'blocked'

export const AUDIT_ACTIONS = [
  'document.validate',
  'state.inspect',
  'plan.create',
  'plan.approve',
  'plan.apply',
  'change.apply',
  'operation.verify',
  'operation.cancel',
  'policy.deny',
  'secret.resolve',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export interface AuditEvent {
  id: string
  /** Monotonic position in the chain, starting at 1. */
  sequence: number
  timestamp: string
  actor: Actor
  action: AuditAction
  resourceType?: string
  resourceKey?: string
  planId?: string
  operationId?: string
  requestId?: string
  outcome: AuditOutcome
  metadata: Record<string, unknown>
  previousEventHash: string | null
  eventHash: string
}

/** The fields covered by `eventHash`. Excludes the hash itself. */
export type AuditEventBody = Omit<AuditEvent, 'eventHash'>

export interface AuditChainVerification {
  valid: boolean
  events: number
  brokenAt?: {
    sequence: number
    eventId: string
    reason: string
  }
}
