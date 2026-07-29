import { describe, expect, it } from 'vitest'
import type { AuditEvent } from '@dsp/protocol'
import { AuditLog, MemoryAuditStore, createAuditEvent, verifyChain } from '@dsp/audit'

const actor = { type: 'agent' as const, id: 'demo-agent' }

function chainOf(count: number): AuditEvent[] {
  const events: AuditEvent[] = []
  let previous: AuditEvent | null = null
  for (let index = 0; index < count; index += 1) {
    const event = createAuditEvent({
      input: { actor, action: 'plan.create', outcome: 'success', metadata: { index } },
      previous,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      id: `evt_${String(index).padStart(24, '0')}`,
    })
    events.push(event)
    previous = event
  }
  return events
}

describe('createAuditEvent', () => {
  it('starts the chain at sequence 1 with no predecessor', () => {
    const [first] = chainOf(1)
    expect(first?.sequence).toBe(1)
    expect(first?.previousEventHash).toBeNull()
    expect(first?.eventHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('links each event to the hash of the one before it', () => {
    const [first, second] = chainOf(2)
    expect(second?.sequence).toBe(2)
    expect(second?.previousEventHash).toBe(first?.eventHash)
  })

  it('omits optional correlation fields instead of writing undefined', () => {
    const [event] = chainOf(1)
    expect(event).not.toHaveProperty('planId')
    expect(event).not.toHaveProperty('operationId')
  })

  it('records the correlation fields it was given', () => {
    const event = createAuditEvent({
      input: {
        actor,
        action: 'plan.apply',
        outcome: 'success',
        planId: 'plan_1',
        operationId: 'op_1',
        requestId: 'req_1',
        resourceType: 'mock.database',
        resourceKey: 'db/main',
      },
      previous: null,
      timestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(event).toMatchObject({
      planId: 'plan_1',
      operationId: 'op_1',
      requestId: 'req_1',
      resourceType: 'mock.database',
      resourceKey: 'db/main',
    })
  })

  it('defaults metadata to an empty object', () => {
    const event = createAuditEvent({
      input: { actor, action: 'plan.create', outcome: 'success' },
      previous: null,
      timestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(event.metadata).toEqual({})
  })
})

describe('verifyChain', () => {
  it('accepts an intact chain, including an empty one', () => {
    expect(verifyChain(chainOf(5))).toEqual({ valid: true, events: 5 })
    expect(verifyChain([])).toEqual({ valid: true, events: 0 })
  })

  it('detects a mutated field, because the hash no longer covers the contents', () => {
    const events = chainOf(3)
    const target = events[1]
    if (target === undefined) expect.unreachable('the chain must have three events')
    else target.outcome = 'failure'

    const result = verifyChain(events)
    expect(result.valid).toBe(false)
    expect(result.brokenAt?.sequence).toBe(2)
    expect(result.brokenAt?.reason).toContain('eventHash does not match')
  })

  it('detects a forged event hash', () => {
    const events = chainOf(2)
    const target = events[1]
    if (target === undefined) expect.unreachable('the chain must have two events')
    else target.eventHash = `sha256:${'0'.repeat(64)}`

    expect(verifyChain(events).brokenAt?.sequence).toBe(2)
  })

  it('detects a broken back-link', () => {
    const events = chainOf(3)
    const target = events[2]
    if (target === undefined) expect.unreachable('the chain must have three events')
    else target.previousEventHash = `sha256:${'1'.repeat(64)}`

    const result = verifyChain(events)
    expect(result.valid).toBe(false)
    expect(result.brokenAt?.reason).toContain('previousEventHash')
  })

  it('detects a removed event', () => {
    const events = chainOf(3)
    const result = verifyChain(
      [events[0], events[2]].filter((event): event is AuditEvent => event !== undefined),
    )
    expect(result.valid).toBe(false)
    expect(result.brokenAt?.reason).toContain('Expected sequence 2')
  })

  it('detects reordered events', () => {
    const events = chainOf(3)
    expect(verifyChain([...events].reverse()).valid).toBe(false)
  })

  it('reports the identity of the first broken event', () => {
    const events = chainOf(2)
    const target = events[1]
    if (target === undefined) expect.unreachable('the chain must have two events')
    else target.metadata = { tampered: true }

    expect(verifyChain(events).brokenAt?.eventId).toBe(target.id)
  })
})

describe('AuditLog', () => {
  it('appends events in order and keeps the chain verifiable', async () => {
    const store = new MemoryAuditStore()
    const log = new AuditLog({ store, now: () => new Date('2026-01-01T00:00:00.000Z') })

    await log.record({ actor, action: 'plan.create', outcome: 'success' })
    await log.record({ actor, action: 'plan.apply', outcome: 'success' })

    const events = await log.list()
    expect(events.map((event) => event.action)).toEqual(['plan.create', 'plan.apply'])
    expect(await log.verify()).toEqual({ valid: true, events: 2 })
  })

  it('serializes concurrent appends so the chain cannot interleave', async () => {
    const store = new MemoryAuditStore()
    const log = new AuditLog({ store })

    await Promise.all(
      Array.from({ length: 50 }, (_unused, index) =>
        log.record({ actor, action: 'change.apply', outcome: 'success', metadata: { index } }),
      ),
    )

    const events = await log.list()
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 50 }, (_unused, index) => index + 1),
    )
    expect(await log.verify()).toEqual({ valid: true, events: 50 })
  })

  it('continues the chain from an existing store', async () => {
    const store = new MemoryAuditStore()
    await new AuditLog({ store }).record({ actor, action: 'plan.create', outcome: 'success' })

    const resumed = new AuditLog({ store })
    const event = await resumed.record({ actor, action: 'plan.apply', outcome: 'success' })

    expect(event.sequence).toBe(2)
    expect(await resumed.verify()).toEqual({ valid: true, events: 2 })
  })

  it('redacts secrets in metadata by key name', async () => {
    const store = new MemoryAuditStore()
    const log = new AuditLog({ store })
    await log.record({
      actor,
      action: 'secret.resolve',
      outcome: 'success',
      metadata: { apiToken: 'plaintext', provider: 'mock' },
    })

    const [event] = await log.list()
    expect(event?.metadata['apiToken']).toBe('[REDACTED]')
    expect(event?.metadata['provider']).toBe('mock')
  })

  it('redacts literal secret values it was told about', async () => {
    const store = new MemoryAuditStore()
    const log = new AuditLog({ store, redactValues: () => ['super-secret-value'] })
    await log.record({
      actor,
      action: 'change.apply',
      outcome: 'success',
      metadata: { note: 'used super-secret-value here' },
    })

    const [event] = await log.list()
    expect(JSON.stringify(event?.metadata)).not.toContain('super-secret-value')
  })

  it('reads a single event back by id', async () => {
    const store = new MemoryAuditStore()
    const log = new AuditLog({ store })
    const written = await log.record({ actor, action: 'plan.create', outcome: 'success' })

    expect((await log.get(written.id))?.id).toBe(written.id)
    expect(await log.get('evt_missing')).toBeNull()
  })
})

describe('MemoryAuditStore', () => {
  async function seeded(): Promise<MemoryAuditStore> {
    const store = new MemoryAuditStore()
    const log = new AuditLog({ store })
    await log.record({ actor, action: 'plan.create', outcome: 'success', planId: 'plan_a' })
    await log.record({
      actor,
      action: 'plan.apply',
      outcome: 'success',
      planId: 'plan_a',
      operationId: 'op_a',
    })
    await log.record({ actor, action: 'plan.create', outcome: 'success', planId: 'plan_b' })
    return store
  }

  it('filters by plan, operation and action', async () => {
    const store = await seeded()
    expect(await store.count()).toBe(3)
    expect((await store.list({ planId: 'plan_a' })).length).toBe(2)
    expect((await store.list({ operationId: 'op_a' })).length).toBe(1)
    expect((await store.list({ action: 'plan.create' })).length).toBe(2)
  })

  it('supports paging by sequence and limiting', async () => {
    const store = await seeded()
    expect((await store.list({ afterSequence: 2 })).map((event) => event.sequence)).toEqual([3])
    expect((await store.list({ limit: 2 })).length).toBe(2)
  })

  it('returns the newest event as the chain tail', async () => {
    const store = await seeded()
    expect((await store.last())?.sequence).toBe(3)
    expect(await new MemoryAuditStore().last()).toBeNull()
  })
})
