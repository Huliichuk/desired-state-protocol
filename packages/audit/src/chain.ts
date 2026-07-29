import {
  auditEventId,
  hashCanonical,
  type Actor,
  type AuditAction,
  type AuditChainVerification,
  type AuditEvent,
  type AuditEventBody,
  type AuditOutcome,
} from '@dsp/protocol'

export interface AuditEventInput {
  actor: Actor
  action: AuditAction
  outcome: AuditOutcome
  resourceType?: string
  resourceKey?: string
  planId?: string
  operationId?: string
  requestId?: string
  metadata?: Record<string, unknown>
}

/**
 * `eventHash = SHA256(canonical(eventBody))` where the body already carries
 * `previousEventHash`. Changing any field of any past event — or reordering
 * events — breaks every hash from that point on.
 *
 * This is not a blockchain: there is no consensus and no distribution. It is a
 * local tamper-evident chain, which is exactly what an audit log needs.
 */
export function computeEventHash(body: AuditEventBody): string {
  return hashCanonical(body)
}

export interface CreateAuditEventOptions {
  input: AuditEventInput
  previous: Pick<AuditEvent, 'sequence' | 'eventHash'> | null
  timestamp: string
  id?: string
}

export function createAuditEvent(options: CreateAuditEventOptions): AuditEvent {
  const { input, previous, timestamp } = options

  const body: AuditEventBody = {
    id: options.id ?? auditEventId(),
    sequence: previous === null ? 1 : previous.sequence + 1,
    timestamp,
    actor: input.actor,
    action: input.action,
    outcome: input.outcome,
    metadata: input.metadata ?? {},
    previousEventHash: previous === null ? null : previous.eventHash,
  }

  if (input.resourceType !== undefined) body.resourceType = input.resourceType
  if (input.resourceKey !== undefined) body.resourceKey = input.resourceKey
  if (input.planId !== undefined) body.planId = input.planId
  if (input.operationId !== undefined) body.operationId = input.operationId
  if (input.requestId !== undefined) body.requestId = input.requestId

  return { ...body, eventHash: computeEventHash(body) }
}

/**
 * Verifies sequence continuity, back-links and every event hash.
 * `events` MUST be ordered by ascending sequence.
 */
export function verifyChain(events: readonly AuditEvent[]): AuditChainVerification {
  let previous: AuditEvent | null = null

  for (const event of events) {
    const expectedSequence = previous === null ? 1 : previous.sequence + 1
    if (event.sequence !== expectedSequence) {
      return broken(
        event,
        `Expected sequence ${expectedSequence}, found ${event.sequence}`,
        events.length,
      )
    }

    const expectedPrevious = previous === null ? null : previous.eventHash
    if (event.previousEventHash !== expectedPrevious) {
      return broken(event, 'previousEventHash does not match the preceding event', events.length)
    }

    const { eventHash, ...body } = event
    if (computeEventHash(body) !== eventHash) {
      return broken(event, 'eventHash does not match the event contents', events.length)
    }

    previous = event
  }

  return { valid: true, events: events.length }
}

function broken(event: AuditEvent, reason: string, total: number): AuditChainVerification {
  return {
    valid: false,
    events: total,
    brokenAt: { sequence: event.sequence, eventId: event.id, reason },
  }
}
