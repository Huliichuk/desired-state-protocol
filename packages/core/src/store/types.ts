import type {
  OwnershipClaim,
  OwnershipSnapshot,
  ApprovalRecord,
  DSPPlan,
  DesiredStateDocument,
  OperationRecord,
} from '@dsp/protocol'

export interface PlanOptions {
  allowDelete?: boolean
  allowReplace?: boolean
  refreshCurrentState?: boolean
}

export interface PlanRecord {
  plan: DSPPlan
  /**
   * The document the plan was built from. Apply needs it to re-project the
   * desired state and to hand providers their document-level configuration —
   * and it means apply never accepts a document from the caller.
   */
  desiredState: DesiredStateDocument
  options: PlanOptions
  environment: string
}

export interface IdempotencyReservation {
  reserved: boolean
  operationId: string
}

export interface RuntimeStore {
  savePlan(record: PlanRecord): Promise<void>
  getPlan(planId: string): Promise<PlanRecord | null>

  saveApproval(record: ApprovalRecord): Promise<void>
  listApprovals(planId: string): Promise<ApprovalRecord[]>

  saveOperation(operation: OperationRecord): Promise<void>
  getOperation(operationId: string): Promise<OperationRecord | null>
  listOperations(planId: string): Promise<OperationRecord[]>

  /**
   * Read-only lookup of a previously applied idempotency key. Checked before
   * anything else in `apply`, so a replayed request is answered from history
   * instead of being re-evaluated against a world it already changed.
   */
  findOperationByIdempotency(input: {
    tenant: string
    planId: string
    idempotencyKey: string
  }): Promise<OperationRecord | null>

  /**
   * Atomically claims `tenant + planId + idempotencyKey`. When the key was
   * already used, returns the existing operation id and `reserved: false`.
   */
  reserveIdempotency(input: {
    tenant: string
    planId: string
    idempotencyKey: string
    operationId: string
  }): Promise<IdempotencyReservation>

  /** Claims held on the given resource keys. */
  ownershipFor(scope: string, resourceKeys: readonly string[]): Promise<OwnershipSnapshot>

  /** Applies the ownership outcome of one operation atomically. */
  recordOwnership(input: {
    claims: readonly OwnershipClaim[]
    releases: readonly OwnershipClaim[]
  }): Promise<void>

  requestCancellation(operationId: string): Promise<boolean>

  close(): void
}
