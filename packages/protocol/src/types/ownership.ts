/**
 * Field ownership.
 *
 * A Desired State document says what should be true. Until now it did not say what
 * it is *responsible for*, and the difference was invisible in three ways:
 *
 *   1. The diff defined which fields changed but not what an `update` does with
 *      them. A provider that replaced an attribute set and one that merged into it
 *      were both conforming, and produced different worlds from the same document.
 *   2. A field a document declared once and then dropped kept whatever value it had.
 *      Nothing recorded that nobody was managing it any more.
 *   3. Two documents touching the same resource each saw the other's value as drift.
 *      They fought, silently, and the last apply won.
 *
 * Ownership is per attribute path, held by one document, and recorded by the runtime
 * rather than by a provider. A provider that had to store it — in vendor metadata,
 * say — would invent a different scheme in every adapter.
 */

/** The document that owns a field: `kind/namespace/name`. */
export type FieldOwner = string

/** The paths one owner holds on one resource. */
export interface OwnershipClaim {
  /**
   * The slice of the external world the claim belongs to: the provider plus the
   * `resourceId` its inspection reported.
   *
   * Resource keys are only unique inside one document's scope, so a global key
   * would make two unrelated resources that happen to share a key string — the
   * `main` database of two different workspaces — look like a conflict.
   */
  scope: string
  resourceKey: string
  /** Attribute paths, sorted, so a claim has one canonical form. */
  paths: string[]
  owner: FieldOwner
}

/** Every claim relevant to a plan. */
export interface OwnershipSnapshot {
  claims: OwnershipClaim[]
}

export const EMPTY_OWNERSHIP_SNAPSHOT: OwnershipSnapshot = Object.freeze({ claims: [] })

export interface FieldConflict {
  path: string
  /** The document that already owns the path. */
  owner: FieldOwner
}

export interface ResourceConflict {
  scope: string
  resourceKey: string
  conflicts: FieldConflict[]
}

/**
 * What a plan does to ownership. Carried in the plan and covered by its hash, so a
 * reviewer sees what the document is taking on, letting go, and fighting over.
 */
export interface PlanOwnership {
  owner: FieldOwner
  /** Paths this document does not own yet and will own once the plan applies. */
  claims: OwnershipClaim[]
  /**
   * Paths this document owns and no longer declares. It stops managing them; their
   * current values persist. Reporting this is the point — it used to happen with no
   * record at all.
   */
  releases: OwnershipClaim[]
  /** Paths another document owns. Any conflict blocks the change that touches it. */
  conflicts: ResourceConflict[]
}

export const EMPTY_PLAN_OWNERSHIP: PlanOwnership = Object.freeze({
  owner: '',
  claims: [],
  releases: [],
  conflicts: [],
})

export function ownershipIsEmpty(ownership: PlanOwnership | null): boolean {
  if (ownership === null) return true
  return (
    ownership.claims.length === 0 &&
    ownership.releases.length === 0 &&
    ownership.conflicts.length === 0
  )
}

/** Builds the scope key for one inspection. */
export function ownershipScope(input: { provider: string; resourceId: string | null }): string {
  return `${input.provider}/${input.resourceId ?? ''}`
}

/** Builds the owner identity for a document. */
export function fieldOwnerFor(input: {
  kind: string
  namespace: string
  name: string
}): FieldOwner {
  return `${input.kind}/${input.namespace}/${input.name}`
}
