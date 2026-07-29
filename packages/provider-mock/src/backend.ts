import type { DatabaseSync } from 'node:sqlite'
import { hashCanonical } from '@dsp/protocol'
import { openDatabase } from './sqlite.js'
import type { StoredResource } from './types.js'

interface Row {
  resource_type: string
  resource_key: string
  external_id: string
  attributes: string
  revision: string
  updated_at: string
}

export interface WorkspaceId {
  namespace: string
  workspace: string
}

/**
 * The mock provider's "external system": a local SQLite database standing in
 * for a SaaS API. It is deliberately a real store rather than an in-memory map,
 * so drift, revisions and idempotency behave like they would in production.
 */
export class MockBackend {
  readonly #db: DatabaseSync
  #clock: () => Date
  #closed = false

  constructor(path = ':memory:', clock: () => Date = () => new Date()) {
    this.#db = openDatabase(path)
    this.#clock = clock
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS mock_resources (
        namespace TEXT NOT NULL,
        workspace TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        external_id TEXT NOT NULL,
        attributes TEXT NOT NULL,
        revision TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, workspace, resource_key)
      )
    `)
  }

  setClock(clock: () => Date): void {
    this.#clock = clock
  }

  list(id: WorkspaceId): StoredResource[] {
    const rows = this.#db
      .prepare(
        `SELECT resource_type, resource_key, external_id, attributes, revision, updated_at
         FROM mock_resources WHERE namespace = ? AND workspace = ?
         ORDER BY resource_key`,
      )
      .all(id.namespace, id.workspace) as unknown as Row[]

    return rows.map(toStoredResource)
  }

  get(id: WorkspaceId, key: string): StoredResource | null {
    const row = this.#db
      .prepare(
        `SELECT resource_type, resource_key, external_id, attributes, revision, updated_at
         FROM mock_resources WHERE namespace = ? AND workspace = ? AND resource_key = ?`,
      )
      .get(id.namespace, id.workspace, key) as unknown as Row | undefined

    return row === undefined ? null : toStoredResource(row)
  }

  /**
   * Creates or updates a resource. Writing the same attributes twice is a
   * no-op apart from the timestamp, which is what makes `applyChange`
   * idempotent under retries.
   */
  upsert(
    id: WorkspaceId,
    resource: { resourceType: string; key: string; attributes: Record<string, unknown> },
  ): StoredResource {
    const existing = this.get(id, resource.key)
    const externalId = existing?.externalId ?? this.#externalId(resource.resourceType, resource.key)
    const serialized = JSON.stringify(resource.attributes)
    const revision = hashCanonical(resource.attributes)
    const updatedAt = this.#clock().toISOString()

    this.#db
      .prepare(
        `INSERT INTO mock_resources
           (namespace, workspace, resource_type, resource_key, external_id, attributes, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, workspace, resource_key)
         DO UPDATE SET attributes = excluded.attributes,
                       revision = excluded.revision,
                       updated_at = excluded.updated_at`,
      )
      .run(
        id.namespace,
        id.workspace,
        resource.resourceType,
        resource.key,
        externalId,
        serialized,
        revision,
        updatedAt,
      )

    return {
      resourceType: resource.resourceType,
      key: resource.key,
      attributes: resource.attributes,
      externalId,
      revision,
      updatedAt,
    }
  }

  delete(id: WorkspaceId, key: string): boolean {
    const result = this.#db
      .prepare(
        'DELETE FROM mock_resources WHERE namespace = ? AND workspace = ? AND resource_key = ?',
      )
      .run(id.namespace, id.workspace, key)
    return Number(result.changes) > 0
  }

  /**
   * Workspace revision used for optimistic concurrency control: any change to
   * any resource changes it.
   */
  revision(id: WorkspaceId): string {
    const resources = this.list(id)
    if (resources.length === 0) return 'empty'
    return hashCanonical(
      resources.map((resource) => ({ key: resource.key, revision: resource.revision })),
    )
  }

  /**
   * Simulates an out-of-band change made by someone else. Used to exercise
   * drift detection and verification mismatches.
   */
  injectDrift(id: WorkspaceId, key: string, patch: Record<string, unknown>): boolean {
    const existing = this.get(id, key)
    if (existing === null) return false
    this.upsert(id, {
      resourceType: existing.resourceType,
      key,
      attributes: { ...existing.attributes, ...patch },
    })
    return true
  }

  reset(): void {
    this.#db.exec('DELETE FROM mock_resources')
  }

  /** Idempotent: a shutdown path may be reached more than once. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  #externalId(resourceType: string, key: string): string {
    const prefix = resourceType.split('.')[1] ?? 'res'
    return `${prefix}_${hashCanonical({ resourceType, key }).slice(7, 19)}`
  }
}

function toStoredResource(row: Row): StoredResource {
  return {
    resourceType: row.resource_type,
    key: row.resource_key,
    attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    externalId: row.external_id,
    revision: row.revision,
    updatedAt: row.updated_at,
  }
}
