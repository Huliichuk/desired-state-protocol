import {
  documentNamespace,
  type ChangeExecutionResult,
  type CurrentState,
  type DesiredStateDocument,
  type KindDefinition,
  type PlanChange,
  type ResourceProjection,
  type ResourceTypeDefinition,
  type SecretReference,
  type ValidationIssue,
  type ValidationResult,
} from '@dsp/protocol'
import {
  providerError,
  providerTimeout,
  unsupportedOperation,
  type DSPProvider,
  type ProviderContext,
  type ProviderExecutionContext,
  type ProviderPlanInput,
} from '@dsp/provider-sdk'
import type { MockBackend, WorkspaceId } from './backend.js'
import { mockKindDefinition, mockResourceTypes } from './definitions.js'
import { projectSpec, projectStored, subscriptionKey, userKey } from './projection.js'
import {
  MOCK_PROVIDER_NAME,
  MOCK_RESOURCE_TYPES,
  type MockWorkspaceSpec,
  type MockWorkspaceState,
} from './types.js'
import { MOCK_PROVIDER_VERSION } from './version.js'

export interface MockProviderOptions {
  backend: MockBackend
}

/**
 * The reference DSP provider. It has no external dependencies, so it can
 * exercise every branch of the protocol — including failures that a real SaaS
 * API would only produce by accident.
 */
export class MockProvider implements DSPProvider<MockWorkspaceSpec, MockWorkspaceState> {
  readonly name = MOCK_PROVIDER_NAME
  readonly version = MOCK_PROVIDER_VERSION
  readonly kinds: KindDefinition[] = [mockKindDefinition]
  readonly resourceTypes: ResourceTypeDefinition[] = mockResourceTypes

  readonly #backend: MockBackend

  constructor(options: MockProviderOptions) {
    this.#backend = options.backend
  }

  get backend(): MockBackend {
    return this.#backend
  }

  requiredSecrets(desired: DesiredStateDocument<MockWorkspaceSpec>): SecretReference[] {
    const reference = desired.spec.credentials?.secretRef
    return reference === undefined ? [] : [reference]
  }

  async validate(
    context: ProviderContext,
    desired: DesiredStateDocument<MockWorkspaceSpec>,
  ): Promise<ValidationResult> {
    const errors: ValidationIssue[] = []
    const warnings: ValidationIssue[] = []
    const spec = desired.spec

    const databaseNames = new Set<string>()
    ;(spec.databases ?? []).forEach((database, index) => {
      if (databaseNames.has(database.name)) {
        errors.push({
          code: 'DUPLICATE_RESOURCE',
          path: `spec.databases[${index}].name`,
          message: `Database "${database.name}" is declared more than once`,
        })
      }
      databaseNames.add(database.name)

      const tableNames = new Set<string>()
      ;(database.tables ?? []).forEach((table, tableIndex) => {
        if (tableNames.has(table.name)) {
          errors.push({
            code: 'DUPLICATE_RESOURCE',
            path: `spec.databases[${index}].tables[${tableIndex}].name`,
            message: `Table "${table.name}" is declared more than once in database "${database.name}"`,
          })
        }
        tableNames.add(table.name)

        const columnNames = new Set<string>()
        table.columns.forEach((column, columnIndex) => {
          if (columnNames.has(column.name)) {
            errors.push({
              code: 'DUPLICATE_RESOURCE',
              path: `spec.databases[${index}].tables[${tableIndex}].columns[${columnIndex}].name`,
              message: `Column "${column.name}" is declared more than once`,
            })
          }
          columnNames.add(column.name)
        })
      })
    })

    const emails = new Set<string>()
    ;(spec.users ?? []).forEach((user, index) => {
      if (emails.has(user.email)) {
        errors.push({
          code: 'DUPLICATE_RESOURCE',
          path: `spec.users[${index}].email`,
          message: `User "${user.email}" is declared more than once`,
        })
      }
      emails.add(user.email)

      if (user.apiToken !== undefined) {
        warnings.push({
          code: 'INLINE_SECRET',
          path: `spec.users[${index}].apiToken`,
          message:
            'Inline API tokens are stored as sensitive attributes and redacted, but a secretRef is preferred',
        })
      }
    })

    const subscribed = new Set<string>()
    ;(spec.subscriptions ?? []).forEach((subscription, index) => {
      if (!emails.has(subscription.user)) {
        errors.push({
          code: 'UNRESOLVED_REFERENCE',
          path: `spec.subscriptions[${index}].user`,
          message: `Subscription references user "${subscription.user}", which is not declared in spec.users`,
        })
      }
      if (subscribed.has(subscription.user)) {
        errors.push({
          code: 'DUPLICATE_RESOURCE',
          path: `spec.subscriptions[${index}].user`,
          message: `User "${subscription.user}" already has a subscription in this document`,
        })
      }
      subscribed.add(subscription.user)
    })

    // Immutable-field drift is reported here as well as in the plan, so a caller
    // that only runs `validate` still learns that the change is impossible.
    const current = await this.inspect(context, desired)
    errors.push(...this.#immutableViolations(desired, current))

    return { valid: errors.length === 0, errors, warnings }
  }

  async inspect(
    context: ProviderContext,
    desired: DesiredStateDocument<MockWorkspaceSpec>,
  ): Promise<CurrentState<MockWorkspaceState>> {
    context.signal.throwIfAborted()
    const id = this.#workspaceId(desired)
    const resources = this.#backend.list(id)

    return {
      resourceType: mockKindDefinition.kind,
      resourceId: `${id.namespace}/${id.workspace}`,
      observedAt: context.now().toISOString(),
      revision: this.#backend.revision(id),
      state: { resources },
    }
  }

  async normalizeDesired(
    desired: DesiredStateDocument<MockWorkspaceSpec>,
  ): Promise<ResourceProjection> {
    return projectSpec(desired.spec)
  }

  async normalizeCurrent(current: CurrentState<MockWorkspaceState>): Promise<ResourceProjection> {
    return projectStored(current.state?.resources ?? [])
  }

  /**
   * Provider-side refinement. The generic diff cannot know that lowering a
   * user's role removes access, so the provider marks it destructive and the
   * risk engine picks that up.
   */
  async plan(
    _context: ProviderContext,
    input: ProviderPlanInput<MockWorkspaceSpec, MockWorkspaceState>,
  ): Promise<PlanChange[]> {
    return input.changes.map((change) => {
      if (change.resourceType !== MOCK_RESOURCE_TYPES.user || change.action !== 'update') {
        return change
      }
      const roleChange = change.fields.find((field) => field.path === 'role')
      if (roleChange === undefined || roleChange.before !== 'admin') return change

      return {
        ...change,
        destructive: true,
        reversible: false,
        reason: `${change.reason}; removing admin access is treated as destructive`,
      }
    })
  }

  async applyChange(
    context: ProviderExecutionContext,
    change: PlanChange,
  ): Promise<ChangeExecutionResult> {
    context.signal.throwIfAborted()

    const desired = context.desired as DesiredStateDocument<MockWorkspaceSpec>
    const simulate = desired.spec.simulate ?? {}
    const id = this.#workspaceId(desired)

    if (simulate.failResourceKey === change.resourceKey) {
      const attemptsToFail = simulate.failAttempts ?? Number.MAX_SAFE_INTEGER
      if (context.attempt <= attemptsToFail) {
        await this.#simulateFailure(context, simulate.failureMode ?? 'permanent', change)
      }
    }

    if (change.action === 'blocked' || change.action === 'noop') {
      throw unsupportedOperation(`The runtime must not execute a "${change.action}" change`, {
        changeId: change.id,
      })
    }

    if (change.action === 'delete') {
      const removed = this.#backend.delete(id, change.resourceKey)
      if (!removed) {
        throw providerError(`Resource "${change.resourceKey}" no longer exists`, {
          details: { resourceKey: change.resourceKey },
        })
      }
      return { externalId: null, providerRequestId: this.#requestId(context, change) }
    }

    const attributes = change.after
    if (attributes === undefined || attributes === null || typeof attributes !== 'object') {
      throw providerError(`Change ${change.id} has no target attributes`, {
        details: { changeId: change.id },
      })
    }

    const stored = this.#backend.upsert(id, {
      resourceType: change.resourceType,
      key: change.resourceKey,
      attributes: attributes as Record<string, unknown>,
    })

    if (simulate.driftResourceKey === change.resourceKey) {
      // Someone else changed the resource right after we wrote it: verification
      // must notice.
      this.#backend.injectDrift(id, change.resourceKey, { region: 'drifted-region' })
    }

    return {
      externalId: stored.externalId,
      providerRequestId: this.#requestId(context, change),
      observed: stored.attributes,
    }
  }

  async #simulateFailure(
    context: ProviderExecutionContext,
    mode: NonNullable<MockWorkspaceSpec['simulate']>['failureMode'],
    change: PlanChange,
  ): Promise<never> {
    switch (mode) {
      case 'retryable':
        throw providerError(`Simulated transient failure for ${change.resourceKey}`, {
          retryable: true,
          details: { resourceKey: change.resourceKey, attempt: context.attempt },
        })
      case 'timeout':
        await new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason as Error), {
            once: true,
          })
        })
        throw providerTimeout(`Simulated timeout for ${change.resourceKey}`)
      case 'permanent':
      case undefined:
        throw providerError(`Simulated permanent failure for ${change.resourceKey}`, {
          retryable: false,
          details: { resourceKey: change.resourceKey },
        })
    }
  }

  #immutableViolations(
    desired: DesiredStateDocument<MockWorkspaceSpec>,
    current: CurrentState<MockWorkspaceState>,
  ): ValidationIssue[] {
    const stored = new Map(
      (current.state?.resources ?? []).map((resource) => [resource.key, resource]),
    )
    const issues: ValidationIssue[] = []

    ;(desired.spec.subscriptions ?? []).forEach((subscription, index) => {
      const existing = stored.get(subscriptionKey(subscription.user))
      if (existing === undefined) return
      if (existing.attributes['currency'] !== subscription.currency) {
        issues.push({
          code: 'IMMUTABLE_FIELD_CHANGED',
          path: `spec.subscriptions[${index}].currency`,
          message: `Currency cannot be changed for an existing subscription (current: ${String(existing.attributes['currency'])})`,
        })
      }
    })

    ;(desired.spec.databases ?? []).forEach((database, index) => {
      const existing = stored.get(`${MOCK_RESOURCE_TYPES.database}/${database.name}`)
      if (existing === undefined) return
      if (existing.attributes['engine'] !== database.engine) {
        issues.push({
          code: 'IMMUTABLE_FIELD_CHANGED',
          path: `spec.databases[${index}].engine`,
          message: `Engine cannot be changed for an existing database (current: ${String(existing.attributes['engine'])})`,
        })
      }
    })

    ;(desired.spec.users ?? []).forEach((user) => {
      // The email is the identity, so a changed email is a different user
      // rather than a violation. Kept explicit so the intent is documented.
      void userKey(user.email)
    })

    return issues
  }

  #workspaceId(desired: DesiredStateDocument<MockWorkspaceSpec>): WorkspaceId {
    return { namespace: documentNamespace(desired), workspace: desired.metadata.name }
  }

  #requestId(context: ProviderExecutionContext, change: PlanChange): string {
    return `mockreq_${context.operationId.slice(3, 11)}_${change.id.slice(4, 12)}`
  }
}
