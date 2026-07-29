import type { DatabaseSync } from 'node:sqlite'
import type { ApprovalRecord, AuditEvent, OperationRecord } from '@dsp/protocol'
import type { AuditQuery, AuditStore } from '@dsp/audit'
import { openDatabase } from './sqlite.js'
import type { IdempotencyReservation, PlanRecord, RuntimeStore } from './types.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  plan_id     TEXT PRIMARY KEY,
  plan_hash   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  record      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  plan_id     TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  plan_hash   TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  record      TEXT NOT NULL,
  PRIMARY KEY (plan_id, approved_by)
);

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  tenant       TEXT NOT NULL,
  plan_id      TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  record       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_plan_idx ON operations (plan_id);

CREATE TABLE IF NOT EXISTS idempotency (
  tenant          TEXT NOT NULL,
  plan_id         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation_id    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (tenant, plan_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id       TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  record   TEXT NOT NULL
);
`

interface RecordRow {
  record: string
}

/**
 * SQLite-backed persistence for plans, approvals, operations, idempotency keys
 * and the audit chain. Records are stored as canonical JSON with the columns
 * that lookups actually need lifted out.
 *
 * Pass `:memory:` for tests: the same code path is exercised either way.
 */
export class SqliteRuntimeStore implements RuntimeStore, AuditStore {
  readonly #db: DatabaseSync
  readonly #now: () => Date
  #closed = false

  constructor(path = ':memory:', now: () => Date = () => new Date()) {
    this.#db = openDatabase(path)
    this.#db.exec(SCHEMA)
    this.#now = now
  }

  async savePlan(record: PlanRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO plans (plan_id, plan_hash, created_at, expires_at, record)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(plan_id) DO UPDATE SET
           plan_hash = excluded.plan_hash,
           expires_at = excluded.expires_at,
           record = excluded.record`,
      )
      .run(
        record.plan.metadata.id,
        record.plan.metadata.planHash,
        record.plan.metadata.createdAt,
        record.plan.metadata.expiresAt,
        JSON.stringify(record),
      )
  }

  async getPlan(planId: string): Promise<PlanRecord | null> {
    const row = this.#db.prepare('SELECT record FROM plans WHERE plan_id = ?').get(planId) as
      RecordRow | undefined
    return row === undefined ? null : (JSON.parse(row.record) as PlanRecord)
  }

  async saveApproval(record: ApprovalRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO approvals (plan_id, approved_by, plan_hash, approved_at, record)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(plan_id, approved_by) DO UPDATE SET
           plan_hash = excluded.plan_hash,
           approved_at = excluded.approved_at,
           record = excluded.record`,
      )
      .run(
        record.planId,
        record.approvedBy,
        record.planHash,
        record.approvedAt,
        JSON.stringify(record),
      )
  }

  async listApprovals(planId: string): Promise<ApprovalRecord[]> {
    const rows = this.#db
      .prepare('SELECT record FROM approvals WHERE plan_id = ? ORDER BY approved_at')
      .all(planId) as unknown as RecordRow[]
    return rows.map((row) => JSON.parse(row.record) as ApprovalRecord)
  }

  async saveOperation(operation: OperationRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO operations (operation_id, tenant, plan_id, status, created_at, updated_at, record)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(operation_id) DO UPDATE SET
           status = excluded.status,
           updated_at = excluded.updated_at,
           record = excluded.record`,
      )
      .run(
        operation.id,
        operation.tenant,
        operation.planId,
        operation.status,
        operation.createdAt,
        operation.updatedAt,
        JSON.stringify(operation),
      )
  }

  async getOperation(operationId: string): Promise<OperationRecord | null> {
    const row = this.#db
      .prepare('SELECT record FROM operations WHERE operation_id = ?')
      .get(operationId) as RecordRow | undefined
    return row === undefined ? null : (JSON.parse(row.record) as OperationRecord)
  }

  async listOperations(planId: string): Promise<OperationRecord[]> {
    const rows = this.#db
      .prepare('SELECT record FROM operations WHERE plan_id = ? ORDER BY created_at')
      .all(planId) as unknown as RecordRow[]
    return rows.map((row) => JSON.parse(row.record) as OperationRecord)
  }

  async findOperationByIdempotency(input: {
    tenant: string
    planId: string
    idempotencyKey: string
  }): Promise<OperationRecord | null> {
    const row = this.#db
      .prepare(
        `SELECT operation_id FROM idempotency
         WHERE tenant = ? AND plan_id = ? AND idempotency_key = ?`,
      )
      .get(input.tenant, input.planId, input.idempotencyKey) as { operation_id: string } | undefined

    return row === undefined ? null : this.getOperation(row.operation_id)
  }

  async reserveIdempotency(input: {
    tenant: string
    planId: string
    idempotencyKey: string
    operationId: string
  }): Promise<IdempotencyReservation> {
    const result = this.#db
      .prepare(
        `INSERT INTO idempotency (tenant, plan_id, idempotency_key, operation_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant, plan_id, idempotency_key) DO NOTHING`,
      )
      .run(
        input.tenant,
        input.planId,
        input.idempotencyKey,
        input.operationId,
        this.#now().toISOString(),
      )

    if (Number(result.changes) > 0) {
      return { reserved: true, operationId: input.operationId }
    }

    const row = this.#db
      .prepare(
        `SELECT operation_id FROM idempotency
         WHERE tenant = ? AND plan_id = ? AND idempotency_key = ?`,
      )
      .get(input.tenant, input.planId, input.idempotencyKey) as { operation_id: string } | undefined

    return { reserved: false, operationId: row?.operation_id ?? input.operationId }
  }

  async requestCancellation(operationId: string): Promise<boolean> {
    const operation = await this.getOperation(operationId)
    if (operation === null) return false
    await this.saveOperation({
      ...operation,
      cancellationRequested: true,
      updatedAt: this.#now().toISOString(),
    })
    return true
  }

  // --- AuditStore ---------------------------------------------------------

  async append(event: AuditEvent): Promise<void> {
    this.#db
      .prepare('INSERT INTO audit_events (id, sequence, record) VALUES (?, ?, ?)')
      .run(event.id, event.sequence, JSON.stringify(event))
  }

  async last(): Promise<AuditEvent | null> {
    const row = this.#db
      .prepare('SELECT record FROM audit_events ORDER BY sequence DESC LIMIT 1')
      .get() as RecordRow | undefined
    return row === undefined ? null : (JSON.parse(row.record) as AuditEvent)
  }

  async list(query: AuditQuery = {}): Promise<AuditEvent[]> {
    const rows = this.#db
      .prepare(
        `SELECT record FROM audit_events
         WHERE sequence > ?
         ORDER BY sequence ASC`,
      )
      .all(query.afterSequence ?? 0) as unknown as RecordRow[]

    let events = rows.map((row) => JSON.parse(row.record) as AuditEvent)
    if (query.planId !== undefined) events = events.filter((event) => event.planId === query.planId)
    if (query.operationId !== undefined) {
      events = events.filter((event) => event.operationId === query.operationId)
    }
    if (query.action !== undefined) events = events.filter((event) => event.action === query.action)
    return query.limit === undefined ? events : events.slice(0, query.limit)
  }

  async get(id: string): Promise<AuditEvent | null> {
    const row = this.#db.prepare('SELECT record FROM audit_events WHERE id = ?').get(id) as
      RecordRow | undefined
    return row === undefined ? null : (JSON.parse(row.record) as AuditEvent)
  }

  async count(): Promise<number> {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM audit_events').get() as
      { total: number } | undefined
    return Number(row?.total ?? 0)
  }

  /** Idempotent: a shutdown path may be reached more than once. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }
}
