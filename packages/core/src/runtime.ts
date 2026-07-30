import {
  DSPError,
  assertDocumentLimits,
  documentNamespace,
  fieldOwnerFor,
  ownershipScope,
  hashEquals,
  operationId as newOperationId,
  mergeValidationResults,
  type Actor,
  type ApprovalRecord,
  type AuditChainVerification,
  type AuditEvent,
  type CurrentState,
  type DSPManifest,
  type DSPPlan,
  type DesiredStateDocument,
  type KindDefinition,
  type OperationRecord,
  type PolicyBundle,
  type PolicyEvaluationContext,
  type ResourceProjection,
  type ResourceTypeDefinition,
  type ValidationIssue,
  type ValidationResult,
  type VerificationResult,
} from '@dsp/protocol'
import { AuditLog, type AuditQuery, type AuditStore } from '@dsp/audit'
import { executePlan, type Sleep } from '@dsp/execution-engine'
import { buildPlan, computePlanHash, isPlanExpired } from '@dsp/plan-engine'
import { evaluatePolicies, policyBundleHash } from '@dsp/policy-engine'
import { evaluatePredicates, validateContract } from '@dsp/contract-engine'
import { claimsToRecord, normalizeProjection, resolveOwnership } from '@dsp/plan-engine'
import type {
  DSPProvider,
  Logger,
  ProviderContext,
  ProviderExecutionContext,
} from '@dsp/provider-sdk'
import { ScopedSecretResolver, type SecretResolver, type SecretStore } from '@dsp/secret-store'
import { verifyDesiredState, verificationFailed } from '@dsp/verification-engine'
import { createRuntimeConfig, type RuntimeConfig } from './config.js'
import { buildManifest } from './manifest.js'
import { redactCurrentStateForOutput, redactPlanForOutput } from './redact.js'
import { ResourceRegistry } from './registry.js'
import type { PlanOptions, PlanRecord, RuntimeStore } from './store/types.js'

export interface DSPRuntimeOptions {
  providers: readonly DSPProvider[]
  store: RuntimeStore
  auditStore: AuditStore
  secretStore: SecretStore
  policyBundle: PolicyBundle
  config?: Partial<RuntimeConfig>
  logger: Logger
  now?: () => Date
  sleep?: Sleep
}

export interface ActorRequest {
  actor: Actor
  requestId?: string
}

export interface ValidateInput extends ActorRequest {
  desiredState: unknown
}

export interface PlanInput extends ActorRequest {
  desiredState: unknown
  options?: PlanOptions
}

export interface ApproveInput extends ActorRequest {
  planId: string
  approvedBy: string
  reason: string
  planHash: string
}

export interface ApplyInput extends ActorRequest {
  planId: string
  idempotencyKey: string
  /** `If-Match`: the revision the caller believes the system is at. */
  ifMatch?: string
}

/**
 * The DSP runtime.
 *
 * It is a deterministic program, not an agent: no model is consulted anywhere in
 * this file. Given the same document, the same external state and the same
 * policies, it produces the same plan, and it refuses to apply anything that is
 * not exactly that plan.
 */
export class DSPRuntime {
  readonly #registry: ResourceRegistry
  readonly #store: RuntimeStore
  readonly #secrets: SecretStore
  readonly #policyBundle: PolicyBundle
  readonly #policyBundleHash: string
  readonly #config: RuntimeConfig
  readonly #logger: Logger
  readonly #now: () => Date
  readonly #sleep: Sleep | undefined
  readonly #audit: AuditLog

  constructor(options: DSPRuntimeOptions) {
    this.#registry = new ResourceRegistry(options.providers)
    this.#store = options.store
    this.#secrets = options.secretStore
    this.#policyBundle = options.policyBundle
    this.#policyBundleHash = policyBundleHash(options.policyBundle)
    this.#config = createRuntimeConfig(options.config)
    this.#logger = options.logger
    this.#now = options.now ?? ((): Date => new Date())
    this.#sleep = options.sleep
    this.#audit = new AuditLog({ store: options.auditStore, now: this.#now })
  }

  // --- discovery ----------------------------------------------------------

  manifest(): DSPManifest {
    return buildManifest(this.#config)
  }

  config(): RuntimeConfig {
    return this.#config
  }

  policyBundleHash(): string {
    return this.#policyBundleHash
  }

  listResourceTypes(): ResourceTypeDefinition[] {
    return this.#registry.resourceTypes()
  }

  getResourceType(name: string): ResourceTypeDefinition {
    return this.#registry.resourceType(name)
  }

  listKinds(): KindDefinition[] {
    return this.#registry.kinds()
  }

  getKind(kind: string): KindDefinition {
    return this.#registry.kind(kind)
  }

  // --- validate -----------------------------------------------------------

  /**
   * Validation never throws for a bad document: an invalid document is a normal
   * answer, not a server error. It throws only when the runtime itself fails.
   */
  async validate(input: ValidateInput): Promise<ValidationResult> {
    const envelope = this.#registry.envelopeValidator().validate(input.desiredState)
    if (!envelope.valid) {
      await this.#recordValidation(input, envelope)
      return envelope
    }

    const document = input.desiredState as DesiredStateDocument
    const errors: ValidationIssue[] = []
    const warnings: ValidationIssue[] = []

    try {
      assertDocumentLimits(document, this.#config.limits)
    } catch (error) {
      errors.push(issueFromError(error, ''))
    }

    let kind: KindDefinition | null = null
    try {
      kind = this.#registry.kind(document.kind)
    } catch (error) {
      errors.push(issueFromError(error, 'kind'))
    }

    if (kind === null || errors.length > 0) {
      const result = { valid: false, errors, warnings }
      await this.#recordValidation(input, result)
      return result
    }

    const specResult = this.#registry.specValidator(kind.kind).validate(document.spec)
    if (!specResult.valid) {
      const result = mergeValidationResults({ valid: false, errors, warnings }, specResult)
      await this.#recordValidation(input, result)
      return result
    }

    const provider = this.#registry.providerForKind(kind.kind)
    const secretIssues = await this.#checkSecretReferences(provider, document)
    errors.push(...secretIssues)

    if (errors.length > 0) {
      const result = { valid: false, errors, warnings }
      await this.#recordValidation(input, result)
      return result
    }

    const { context, dispose } = this.#providerContext(provider, document)
    try {
      const providerResult = await provider.validate(context, document)
      const result = mergeValidationResults(
        { valid: true, errors, warnings },
        providerResult,
        validateContract(document.contract),
      )
      await this.#recordValidation(input, result)
      return result
    } finally {
      dispose()
    }
  }

  // --- inspect ------------------------------------------------------------

  async inspect(input: ValidateInput): Promise<CurrentState> {
    const { document, provider } = await this.#prepare(input.desiredState)
    const { context, dispose } = this.#providerContext(provider, document)
    try {
      const current = await provider.inspect(context, document)
      await this.#audit.record({
        actor: input.actor,
        action: 'state.inspect',
        outcome: 'success',
        resourceType: document.kind,
        resourceKey: documentIdentity(document),
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        metadata: { revision: current.revision ?? null },
      })
      return redactCurrentStateForOutput(current)
    } finally {
      dispose()
    }
  }

  // --- plan ---------------------------------------------------------------

  async plan(input: PlanInput): Promise<DSPPlan> {
    const options = input.options ?? {}
    if (options.refreshCurrentState === false) {
      throw new DSPError(
        'NOT_IMPLEMENTED',
        'This runtime has no current-state cache; refreshCurrentState:false is not supported',
      )
    }
    if (options.allowDelete === true && !this.#config.allowDestructive) {
      throw new DSPError(
        'DESTRUCTIVE_ACTION_BLOCKED',
        'This runtime is configured to refuse deletions; allowDelete cannot be enabled per request',
      )
    }

    const { document, provider } = await this.#prepare(input.desiredState)
    const { context, dispose } = this.#providerContext(provider, document)

    try {
      const current = await provider.inspect(context, document)
      const desiredProjection = await provider.normalizeDesired(document)
      const currentProjection = await provider.normalizeCurrent(current)
      const refine = provider.plan?.bind(provider)

      this.#assertResourceLimits(desiredProjection, currentProjection)

      // Ownership is resolved against what the runtime already records, so a field
      // another document is responsible for is visible in the plan rather than
      // quietly overwritten at apply time.
      const owner = fieldOwnerFor({
        kind: document.kind,
        namespace: documentNamespace(document),
        name: document.metadata.name,
      })
      // The scope is the slice of the world the provider just inspected, so two
      // documents pointed at different workspaces never collide over a shared key.
      const scope = ownershipScope({ provider: provider.name, resourceId: current.resourceId })
      const keys = resourceKeysInPlay(desiredProjection, currentProjection)
      const ownership = resolveOwnership({
        owner,
        scope,
        desired: normalizeProjection(desiredProjection),
        current: normalizeProjection(currentProjection),
        snapshot: await this.#store.ownershipFor(scope, keys),
      })

      const plan = await buildPlan({
        desired: document,
        desiredProjection,
        currentProjection,
        currentRevision: current.revision ?? null,
        resourceTypes: this.#registry.resourceTypeMap(),
        provider: provider.name,
        environment: this.#config.environment,
        policyBundleHash: this.#policyBundleHash,
        evaluatePolicies: ({ changes, risk }) =>
          evaluatePolicies(this.#policyBundle, {
            changes,
            risk,
            context: this.#policyContext(document),
          }),
        // The client's own bounds, checked against what it asked for. A document
        // that contradicts itself never reaches a provider. Null rather than a
        // vacuously satisfied check when no contract was declared at all.
        ownership,
        contract:
          document.contract === undefined
            ? null
            : evaluatePredicates(
                document.contract.goal,
                document.contract.constraints,
                desiredProjection,
              ),
        ...(refine === undefined
          ? {}
          : {
              refineChanges: (changes) => refine(context, { desired: document, current, changes }),
            }),
        limits: this.#config.limits,
        now: this.#now(),
        options: {
          allowDelete: options.allowDelete === true && this.#config.allowDestructive,
          allowReplace: options.allowReplace === true && this.#config.allowDestructive,
        },
      })

      const record: PlanRecord = {
        plan: await this.#preserveValidityWindow(plan),
        desiredState: document,
        options,
        environment: this.#config.environment,
      }
      await this.#store.savePlan(record)

      await this.#audit.record({
        actor: input.actor,
        action: 'plan.create',
        outcome: plan.executable ? 'success' : 'blocked',
        planId: plan.metadata.id,
        resourceType: document.kind,
        resourceKey: documentIdentity(document),
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        metadata: {
          planHash: plan.metadata.planHash,
          summary: plan.summary,
          executable: plan.executable,
          approvalRequired: plan.approvals.required,
          policyDecisions: plan.policyEvaluation.decisions.map((decision) => ({
            policyId: decision.policyId,
            ruleId: decision.ruleId,
            effect: decision.effect,
          })),
        },
      })

      return this.#redact(record.plan)
    } finally {
      dispose()
    }
  }

  /**
   * A plan id is derived from the plan hash, so re-planning an unchanged world
   * lands on the plan that already exists. Its validity window is kept as it was:
   * letting a re-plan push `expiresAt` forward would turn the TTL into a formality
   * and keep an old human approval — which is bound to the hash — alive forever.
   *
   * Once the window has closed, a re-plan opens a new one, and
   * `#assertApproved` stops counting approvals from the previous window.
   */
  async #preserveValidityWindow(plan: DSPPlan): Promise<DSPPlan> {
    const stored = await this.#store.getPlan(plan.metadata.id)
    if (stored === null) return plan
    if (isPlanExpired(stored.plan, this.#now())) return plan

    return {
      ...plan,
      metadata: {
        ...plan.metadata,
        createdAt: stored.plan.metadata.createdAt,
        expiresAt: stored.plan.metadata.expiresAt,
      },
    }
  }

  async getPlan(planId: string): Promise<DSPPlan> {
    return this.#redact((await this.#requirePlan(planId)).plan)
  }

  // --- approve ------------------------------------------------------------

  async approve(input: ApproveInput): Promise<ApprovalRecord> {
    const record = await this.#requirePlan(input.planId)
    const plan = record.plan

    if (!hashEquals(input.planHash, plan.metadata.planHash)) {
      throw new DSPError(
        'APPROVAL_INVALID',
        'The approved plan hash does not match the stored plan; review the current plan again',
        {
          details: { expected: plan.metadata.planHash, received: input.planHash },
        },
      )
    }
    if (isPlanExpired(plan, this.#now())) {
      throw new DSPError('PLAN_EXPIRED', 'The plan has expired and can no longer be approved', {
        details: { expiresAt: plan.metadata.expiresAt },
      })
    }

    const approval: ApprovalRecord = {
      planId: plan.metadata.id,
      planHash: plan.metadata.planHash,
      approvedBy: input.approvedBy,
      approvedAt: this.#now().toISOString(),
      reason: input.reason,
      requirementIds: plan.approvals.requirements.map((requirement) => requirement.id),
    }
    await this.#store.saveApproval(approval)

    await this.#audit.record({
      actor: input.actor,
      action: 'plan.approve',
      outcome: 'success',
      planId: plan.metadata.id,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      metadata: {
        approvedBy: input.approvedBy,
        reason: input.reason,
        planHash: plan.metadata.planHash,
      },
    })

    return approval
  }

  // --- apply --------------------------------------------------------------

  async apply(input: ApplyInput): Promise<OperationRecord> {
    if (input.idempotencyKey.trim().length === 0) {
      throw new DSPError('IDEMPOTENCY_KEY_REQUIRED', 'Apply requires a non-empty Idempotency-Key')
    }

    const record = await this.#requirePlan(input.planId)
    const plan = record.plan
    const provider = this.#registry.providerForKind(record.desiredState.kind)

    // Idempotency is checked first, before anything observes or touches the
    // outside world. A replayed apply must be answered from history: it already
    // changed the state it would now be compared against.
    const replayed = await this.#store.findOperationByIdempotency({
      tenant: this.#config.tenant,
      planId: input.planId,
      idempotencyKey: input.idempotencyKey,
    })
    if (replayed !== null) {
      this.#logger.info(
        { operationId: replayed.id, planId: input.planId },
        'idempotent apply returned the existing operation',
      )
      return replayed
    }

    await this.#assertPlanIntegrity(plan)
    await this.#assertPolicyStillAllows(plan, record)
    await this.#assertOwnershipStillHeld(plan)
    await this.#assertApproved(plan, input)

    const { context, dispose } = this.#providerContext(provider, record.desiredState)
    try {
      const observed = await provider.inspect(context, record.desiredState)
      await this.#assertNoDrift(plan, observed, input)

      const reservation = await this.#store.reserveIdempotency({
        tenant: this.#config.tenant,
        planId: plan.metadata.id,
        idempotencyKey: input.idempotencyKey,
        operationId: newOperationId(),
      })

      if (!reservation.reserved) {
        // Lost a race with a concurrent apply using the same key.
        const existing = await this.#store.getOperation(reservation.operationId)
        if (existing !== null) return existing
      }

      let operation: OperationRecord = {
        id: reservation.operationId,
        tenant: this.#config.tenant,
        planId: plan.metadata.id,
        planHash: plan.metadata.planHash,
        idempotencyKey: input.idempotencyKey,
        status: 'created',
        actor: input.actor,
        createdAt: this.#now().toISOString(),
        updatedAt: this.#now().toISOString(),
        changes: [],
        verification: null,
        cancellationRequested: false,
        error: null,
      }
      await this.#store.saveOperation(operation)

      await this.#audit.record({
        actor: input.actor,
        action: 'plan.apply',
        outcome: 'success',
        planId: plan.metadata.id,
        operationId: operation.id,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        metadata: { planHash: plan.metadata.planHash, summary: plan.summary },
      })

      operation = await executePlan({
        plan,
        operation,
        provider,
        logger: this.#logger,
        createContext: ({ attempt, signal }) =>
          this.#executionContext({
            document: record.desiredState,
            provider,
            operationId: operation.id,
            idempotencyKey: input.idempotencyKey,
            attempt,
            signal,
          }),
        onProgress: async (current) => {
          await this.#store.saveOperation(current)
        },
        isCancellationRequested: async () => {
          const latest = await this.#store.getOperation(operation.id)
          return latest?.cancellationRequested === true
        },
        retry: this.#config.retry,
        timeoutMs: this.#config.limits.providerCallTimeoutMs,
        now: this.#now,
        ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
      })

      for (const change of operation.changes) {
        await this.#audit.record({
          actor: input.actor,
          action: 'change.apply',
          outcome:
            change.status === 'succeeded'
              ? 'success'
              : change.status === 'blocked'
                ? 'blocked'
                : change.status === 'failed'
                  ? 'failure'
                  : 'success',
          planId: plan.metadata.id,
          operationId: operation.id,
          resourceType: change.resourceType,
          resourceKey: change.resourceKey,
          metadata: {
            action: change.action,
            status: change.status,
            attempts: change.attempts,
            externalId: change.externalId ?? null,
            providerRequestId: change.providerRequestId ?? null,
            ...(change.error == null ? {} : { errorCode: change.error.code }),
          },
        })
      }

      // Verification is not optional: an apply that is not verified is only a
      // claim about the world.
      await this.#recordOwnership(plan, operation, record, provider)

      const verification = await this.#runVerification(operation, record, provider, input.actor)
      operation = await this.#applyVerification(operation, verification)
      return operation
    } finally {
      dispose()
    }
  }

  // --- operations ---------------------------------------------------------

  async getOperation(operationId: string): Promise<OperationRecord> {
    const operation = await this.#store.getOperation(operationId)
    if (operation === null) {
      throw new DSPError('OPERATION_NOT_FOUND', `Operation "${operationId}" does not exist`, {
        details: { operationId },
      })
    }
    return operation
  }

  async verify(operationId: string, actor: Actor): Promise<VerificationResult> {
    const operation = await this.getOperation(operationId)
    const record = await this.#requirePlan(operation.planId)
    const provider = this.#registry.providerForKind(record.desiredState.kind)

    const verification = await this.#runVerification(operation, record, provider, actor)
    await this.#applyVerification(operation, verification)
    return verification
  }

  async cancel(operationId: string, actor: Actor): Promise<OperationRecord> {
    const operation = await this.getOperation(operationId)
    if (['completed', 'failed', 'cancelled', 'verification_failed'].includes(operation.status)) {
      throw new DSPError(
        'CANCELLED',
        `Operation "${operationId}" is already in a terminal state (${operation.status})`,
        { details: { operationId, status: operation.status } },
      )
    }

    await this.#store.requestCancellation(operationId)
    const updated: OperationRecord = {
      ...operation,
      cancellationRequested: true,
      status: operation.status === 'created' ? 'cancelled' : operation.status,
      updatedAt: this.#now().toISOString(),
    }
    await this.#store.saveOperation(updated)

    await this.#audit.record({
      actor,
      action: 'operation.cancel',
      outcome: 'success',
      operationId,
      planId: operation.planId,
      metadata: { previousStatus: operation.status },
    })

    return updated
  }

  // --- audit --------------------------------------------------------------

  async audit(query?: AuditQuery): Promise<AuditEvent[]> {
    return this.#audit.list(query)
  }

  async auditEvent(id: string): Promise<AuditEvent> {
    const event = await this.#audit.get(id)
    if (event === null) {
      throw new DSPError('OPERATION_NOT_FOUND', `Audit event "${id}" does not exist`, {
        details: { eventId: id },
      })
    }
    return event
  }

  async verifyAuditChain(): Promise<AuditChainVerification> {
    return this.#audit.verify()
  }

  // --- internals ----------------------------------------------------------

  async #prepare(raw: unknown): Promise<{ document: DesiredStateDocument; provider: DSPProvider }> {
    const document = this.#registry.asDocument(raw)
    assertDocumentLimits(document, this.#config.limits)

    const kind = this.#registry.kind(document.kind)
    const specResult = this.#registry.specValidator(kind.kind).validate(document.spec)
    if (!specResult.valid) {
      throw new DSPError(
        'SCHEMA_VALIDATION_FAILED',
        `spec does not match the schema of ${kind.kind}`,
        {
          details: { errors: specResult.errors },
        },
      )
    }

    const contractResult = validateContract(document.contract)
    if (!contractResult.valid) {
      throw new DSPError('CONTRACT_PREDICATE_INVALID', 'The contract cannot be evaluated', {
        details: { errors: contractResult.errors },
      })
    }

    const provider = this.#registry.providerForKind(kind.kind)
    const { context, dispose } = this.#providerContext(provider, document)
    try {
      const providerResult = await provider.validate(context, document)
      if (!providerResult.valid) {
        throw new DSPError(
          'VALIDATION_FAILED',
          `Desired State document is not valid for ${kind.kind}`,
          {
            details: { errors: providerResult.errors },
          },
        )
      }
    } finally {
      dispose()
    }

    return { document, provider }
  }

  #providerContext(
    provider: DSPProvider,
    document: DesiredStateDocument,
  ): { context: ProviderContext; dispose: () => void } {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Provider call timed out', 'TimeoutError')),
      this.#config.limits.providerCallTimeoutMs,
    )
    timeout.unref?.()

    return {
      context: {
        environment: this.#config.environment,
        namespace: documentNamespace(document),
        logger: this.#logger.child({ provider: provider.name, kind: document.kind }),
        secrets: this.#resolverFor(provider, document),
        signal: controller.signal,
        limits: this.#config.limits,
        now: this.#now,
      },
      dispose: () => clearTimeout(timeout),
    }
  }

  #executionContext(input: {
    document: DesiredStateDocument
    provider: DSPProvider
    operationId: string
    idempotencyKey: string
    attempt: number
    signal: AbortSignal
  }): ProviderExecutionContext {
    return {
      environment: this.#config.environment,
      namespace: documentNamespace(input.document),
      logger: this.#logger.child({
        provider: input.provider.name,
        operationId: input.operationId,
      }),
      secrets: this.#resolverFor(input.provider, input.document),
      signal: input.signal,
      limits: this.#config.limits,
      now: this.#now,
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      attempt: input.attempt,
      desired: input.document,
    }
  }

  /**
   * A provider only ever sees the secrets its own `requiredSecrets` declared for
   * this document. It never receives the store.
   */
  #resolverFor(provider: DSPProvider, document: DesiredStateDocument): SecretResolver {
    const references = provider.requiredSecrets(document)
    return new ScopedSecretResolver(this.#secrets, references, (reference) => {
      void this.#audit.record({
        actor: { type: 'system', id: 'runtime' },
        action: 'secret.resolve',
        outcome: 'success',
        metadata: { provider: provider.name, secret: reference.name },
      })
    })
  }

  #policyContext(document: DesiredStateDocument): PolicyEvaluationContext {
    // The environment comes from runtime configuration only. A document label
    // must never be able to talk its way into a weaker policy.
    return {
      environment: this.#config.environment,
      kind: document.kind,
      namespace: documentNamespace(document),
      resourceName: document.metadata.name,
    }
  }

  #redact(plan: DSPPlan): DSPPlan {
    return redactPlanForOutput(plan, this.#registry.resourceTypeMap())
  }

  async #requirePlan(planId: string): Promise<PlanRecord> {
    const record = await this.#store.getPlan(planId)
    if (record === null) {
      throw new DSPError('PLAN_NOT_FOUND', `Plan "${planId}" does not exist`, {
        details: { planId },
      })
    }
    return record
  }

  async #assertPlanIntegrity(plan: DSPPlan): Promise<void> {
    const recomputed = computePlanHash(plan)
    if (!hashEquals(recomputed, plan.metadata.planHash)) {
      throw new DSPError('PLAN_HASH_MISMATCH', 'The stored plan does not match its own hash', {
        details: { expected: plan.metadata.planHash, recomputed },
      })
    }
    if (isPlanExpired(plan, this.#now())) {
      throw new DSPError('PLAN_EXPIRED', 'The plan has expired; create a new plan', {
        details: { expiresAt: plan.metadata.expiresAt },
      })
    }
    if (!plan.executable) {
      throw new DSPError('PLAN_NOT_EXECUTABLE', 'The plan was not executable when it was created', {
        details: { planId: plan.metadata.id },
      })
    }
  }

  async #assertPolicyStillAllows(plan: DSPPlan, record: PlanRecord): Promise<void> {
    if (!hashEquals(this.#policyBundleHash, plan.metadata.policyBundleHash)) {
      throw new DSPError(
        'POLICY_DENIED',
        'The policy bundle changed after this plan was created; create a new plan',
        {
          details: {
            planPolicyBundleHash: plan.metadata.policyBundleHash,
            currentPolicyBundleHash: this.#policyBundleHash,
          },
        },
      )
    }

    const reevaluated = evaluatePolicies(this.#policyBundle, {
      changes: plan.changes,
      risk: { score: plan.summary.riskScore, level: plan.summary.risk },
      context: this.#policyContext(record.desiredState),
    })

    if (!reevaluated.allowed) {
      const denials = reevaluated.decisions.filter((decision) => decision.effect === 'deny')
      await this.#audit.record({
        actor: { type: 'system', id: 'runtime' },
        action: 'policy.deny',
        outcome: 'blocked',
        planId: plan.metadata.id,
        metadata: { denials },
      })
      throw new DSPError('POLICY_DENIED', 'Policy evaluation denied this plan', {
        details: { denials },
      })
    }
  }

  async #assertApproved(plan: DSPPlan, input: ApplyInput): Promise<void> {
    if (!plan.approvals.required) return

    // An approval counts only for the plan instance it was given for: same hash,
    // and inside the same validity window. A decision taken before the current
    // window opened is a stale human judgement, not an authorization.
    const windowOpenedAt = Date.parse(plan.metadata.createdAt)
    const approvals = (await this.#store.listApprovals(plan.metadata.id)).filter(
      (approval) =>
        hashEquals(approval.planHash, plan.metadata.planHash) &&
        Date.parse(approval.approvedAt) >= windowOpenedAt,
    )

    const missing = plan.approvals.requirements.filter(
      (requirement) => approvals.length < requirement.minApprovals,
    )

    if (missing.length > 0) {
      throw new DSPError(
        'APPROVAL_REQUIRED',
        'This plan requires approval before it can be applied',
        {
          details: {
            planId: plan.metadata.id,
            planHash: plan.metadata.planHash,
            approvals: approvals.length,
            requirements: missing.map((requirement) => ({
              id: requirement.id,
              reason: requirement.reason,
              minApprovals: requirement.minApprovals,
            })),
            idempotencyKey: input.idempotencyKey,
          },
        },
      )
    }
  }

  async #assertNoDrift(plan: DSPPlan, observed: CurrentState, input: ApplyInput): Promise<void> {
    const actual = observed.revision ?? null
    const expected = plan.metadata.currentRevision

    if (input.ifMatch !== undefined && actual !== null && input.ifMatch !== actual) {
      throw new DSPError(
        'STATE_DRIFT_DETECTED',
        'The If-Match revision does not match the current state',
        {
          details: { expectedRevision: input.ifMatch, actualRevision: actual },
        },
      )
    }

    if (expected !== actual) {
      throw new DSPError(
        'STATE_DRIFT_DETECTED',
        'Current state changed after the plan was created',
        { details: { expectedRevision: expected, actualRevision: actual } },
      )
    }
  }

  /**
   * A plan is built against the ownership record as it was. Between then and now
   * another document may have taken a field, so the check is repeated — the same
   * reason policy is re-evaluated before executing.
   */
  async #assertOwnershipStillHeld(plan: DSPPlan): Promise<void> {
    const ownership = plan.ownership
    if (ownership === null) return

    const scope = ownership.claims[0]?.scope ?? ownership.conflicts[0]?.scope
    const keys = [
      ...new Set([
        ...ownership.claims.map((claim) => claim.resourceKey),
        ...ownership.conflicts.map((conflict) => conflict.resourceKey),
      ]),
    ]
    if (keys.length === 0 || scope === undefined) return

    const held = new Map<string, string>()
    for (const claim of (await this.#store.ownershipFor(scope, keys)).claims) {
      for (const path of claim.paths) held.set(`${claim.resourceKey} ${path}`, claim.owner)
    }

    const taken = ownership.claims.flatMap((claim) =>
      claim.paths
        .map((path) => ({ path, owner: held.get(`${claim.resourceKey} ${path}`) }))
        .filter((entry) => entry.owner !== undefined && entry.owner !== ownership.owner)
        .map((entry) => ({ resourceKey: claim.resourceKey, path: entry.path, owner: entry.owner })),
    )

    if (taken.length > 0) {
      throw new DSPError(
        'FIELD_OWNERSHIP_CONFLICT',
        'Another document took ownership of a field this plan claims; a new plan is required',
        { details: { fields: taken } },
      )
    }
  }

  /**
   * Records what the document now manages.
   *
   * Only resources whose change actually landed are claimed: a blocked or failed
   * change means the document did not get to set those fields, so claiming them
   * would make it responsible for values it never wrote.
   */
  async #recordOwnership(
    plan: DSPPlan,
    operation: OperationRecord,
    record: PlanRecord,
    provider: DSPProvider,
  ): Promise<void> {
    const ownership = plan.ownership
    if (ownership === null) return

    const landed = new Set(
      operation.changes
        .filter((change) => change.status === 'succeeded' || change.action === 'noop')
        .map((change) => change.resourceKey),
    )
    const skipResourceKeys = new Set(
      plan.changes.map((change) => change.resourceKey).filter((key) => !landed.has(key)),
    )

    // Inspected again for the scope: the provider's resourceId is what identifies
    // which world these claims belong to.
    const { context, dispose } = this.#providerContext(provider, record.desiredState)
    let observed
    try {
      observed = await provider.inspect(context, record.desiredState)
    } finally {
      dispose()
    }
    const desired = normalizeProjection(await provider.normalizeDesired(record.desiredState))

    await this.#store.recordOwnership({
      claims: claimsToRecord({
        owner: ownership.owner,
        scope: ownershipScope({ provider: provider.name, resourceId: observed.resourceId }),
        desired,
        skipResourceKeys,
      }),
      releases: ownership.releases,
    })
  }

  async #runVerification(
    operation: OperationRecord,
    record: PlanRecord,
    provider: DSPProvider,
    actor: Actor,
  ): Promise<VerificationResult> {
    const { context, dispose } = this.#providerContext(provider, record.desiredState)
    try {
      let verification: VerificationResult
      if (provider.verify !== undefined) {
        verification = await provider.verify(context, {
          desired: record.desiredState,
          operation,
        })
      } else {
        const observed = await provider.inspect(context, record.desiredState)
        const observedProjection = await provider.normalizeCurrent(observed)
        verification = verifyDesiredState({
          operationId: operation.id,
          desiredProjection: await provider.normalizeDesired(record.desiredState),
          observedProjection,
          resourceTypes: this.#registry.resourceTypeMap(),
          now: this.#now(),
          // Evaluated against the state the provider actually reports, not against
          // the document: that is the whole point of a success condition.
          contract:
            record.desiredState.contract === undefined
              ? null
              : evaluatePredicates(
                  record.desiredState.contract.goal,
                  record.desiredState.contract.success,
                  observedProjection,
                ),
        })
      }

      await this.#audit.record({
        actor,
        action: 'operation.verify',
        outcome: verification.status === 'satisfied' ? 'success' : 'failure',
        operationId: operation.id,
        planId: operation.planId,
        metadata: {
          status: verification.status,
          satisfaction: verification.satisfaction,
          unmatched: verification.unmatched.length,
        },
      })

      return verification
    } catch (error) {
      this.#logger.error(
        { operationId: operation.id, error: String(error) },
        'verification could not be completed',
      )
      return verificationFailed(
        operation.id,
        DSPError.isDSPError(error) ? error.message : 'Verification could not be completed',
        this.#now(),
      )
    } finally {
      dispose()
    }
  }

  async #applyVerification(
    operation: OperationRecord,
    verification: VerificationResult,
  ): Promise<OperationRecord> {
    // Structural failure is the more basic problem, so it takes precedence. An
    // operation that did everything asked of it and still missed the point gets a
    // status of its own rather than being reported as a success.
    const status =
      operation.status !== 'completed'
        ? operation.status
        : verification.status !== 'satisfied'
          ? 'verification_failed'
          : verification.contract !== null && !verification.contract.satisfied
            ? 'goal_not_satisfied'
            : operation.status

    const updated: OperationRecord = {
      ...operation,
      verification,
      status,
      updatedAt: this.#now().toISOString(),
    }
    await this.#store.saveOperation(updated)
    return updated
  }

  async #checkSecretReferences(
    provider: DSPProvider,
    document: DesiredStateDocument,
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = []
    for (const reference of provider.requiredSecrets(document)) {
      try {
        await this.#secrets.getSecret(reference)
      } catch (error) {
        issues.push({
          code: DSPError.isDSPError(error) ? error.code : 'SECRET_NOT_FOUND',
          path: 'spec.credentials.secretRef.name',
          message: DSPError.isDSPError(error)
            ? error.message
            : `Secret "${reference.name}" could not be resolved`,
        })
      }
    }
    return issues
  }

  #assertResourceLimits(desired: ResourceProjection, current: ResourceProjection): void {
    const total = Math.max(desired.resources.length, current.resources.length)
    if (total > this.#config.limits.maxResources) {
      throw new DSPError(
        'TOO_MANY_RESOURCES',
        `Projection contains ${total} resources, limit is ${this.#config.limits.maxResources}`,
        { details: { resources: total, limit: this.#config.limits.maxResources } },
      )
    }
  }

  async #recordValidation(input: ValidateInput, result: ValidationResult): Promise<void> {
    const kind =
      typeof input.desiredState === 'object' && input.desiredState !== null
        ? String((input.desiredState as { kind?: unknown }).kind ?? 'unknown')
        : 'unknown'

    await this.#audit.record({
      actor: input.actor,
      action: 'document.validate',
      outcome: result.valid ? 'success' : 'failure',
      resourceType: kind,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      metadata: {
        valid: result.valid,
        errors: result.errors.length,
        warnings: result.warnings.length,
        codes: [...new Set(result.errors.map((issue) => issue.code))],
      },
    })
  }
}

function documentIdentity(document: DesiredStateDocument): string {
  return `${document.kind}/${documentNamespace(document)}/${document.metadata.name}`
}

function issueFromError(error: unknown, path: string): ValidationIssue {
  if (DSPError.isDSPError(error)) {
    return { code: error.code, path, message: error.message }
  }
  return { code: 'VALIDATION_FAILED', path, message: 'Document could not be validated' }
}

/**
 * Every resource key a plan could concern: what the document declares and what the
 * world already holds. Scoping the ownership read to these avoids loading the whole
 * record to plan one document.
 */
function resourceKeysInPlay(desired: ResourceProjection, current: ResourceProjection): string[] {
  return [
    ...new Set([
      ...desired.resources.map((resource) => resource.key),
      ...current.resources.map((resource) => resource.key),
    ]),
  ].sort()
}
