import {
  DSPError,
  toErrorPayload,
  type ChangeExecutionRecord,
  type ChangeStatus,
  type DSPPlan,
  type OperationRecord,
  type OperationStatus,
  type PlanChange,
} from '@dsp/protocol'
import type { DSPProvider, Logger, ProviderExecutionContext } from '@dsp/provider-sdk'
import { DEFAULT_RETRY, backoffDelay, realSleep, type RetryOptions, type Sleep } from './retry.js'

export interface ExecutePlanInput {
  plan: DSPPlan
  operation: OperationRecord
  provider: DSPProvider
  logger: Logger
  /** Builds the per-attempt provider context, including the timeout signal. */
  createContext(input: {
    change: PlanChange
    attempt: number
    signal: AbortSignal
  }): ProviderExecutionContext
  /** Persists progress after every change. */
  onProgress(operation: OperationRecord): Promise<void>
  /** Checked between changes so a long apply can be stopped. */
  isCancellationRequested(): Promise<boolean>
  retry?: RetryOptions
  timeoutMs: number
  now?: () => Date
  sleep?: Sleep
  /** External cancellation, e.g. server shutdown. */
  signal?: AbortSignal
}

/**
 * Executes an immutable plan.
 *
 * Guarantees:
 *   - only changes contained in the plan are executed
 *   - changes already recorded as `succeeded` are never executed again
 *   - `noop` changes are skipped, `blocked` changes are never executed
 *   - a change whose dependency is not satisfied is skipped, not attempted
 *   - only retryable provider errors are retried, with exponential backoff
 */
export async function executePlan(input: ExecutePlanInput): Promise<OperationRecord> {
  const now = input.now ?? ((): Date => new Date())
  const sleep = input.sleep ?? realSleep
  const retry = input.retry ?? DEFAULT_RETRY

  const records = new Map<string, ChangeExecutionRecord>(
    input.operation.changes.map((record) => [record.changeId, record]),
  )
  let operation: OperationRecord = {
    ...input.operation,
    status: 'running',
    updatedAt: now().toISOString(),
  }
  await input.onProgress(operation)

  for (const change of input.plan.changes) {
    const existing = records.get(change.id)
    if (existing?.status === 'succeeded') continue

    if (await input.isCancellationRequested()) {
      operation = commit(operation, records, now, true)
      await input.onProgress(operation)
      return operation
    }

    const record = await runChange({
      change,
      records,
      input,
      retry,
      sleep,
      now,
    })
    records.set(change.id, record)

    operation = {
      ...operation,
      changes: orderRecords(input.plan, records),
      updatedAt: now().toISOString(),
    }
    await input.onProgress(operation)
  }

  operation = commit(operation, records, now, false)
  await input.onProgress(operation)
  return operation
}

interface RunChangeInput {
  change: PlanChange
  records: Map<string, ChangeExecutionRecord>
  input: ExecutePlanInput
  retry: RetryOptions
  sleep: Sleep
  now: () => Date
}

async function runChange({
  change,
  records,
  input,
  retry,
  sleep,
  now,
}: RunChangeInput): Promise<ChangeExecutionRecord> {
  const base: ChangeExecutionRecord = {
    changeId: change.id,
    resourceType: change.resourceType,
    resourceKey: change.resourceKey,
    action: change.action,
    status: 'pending',
    attempts: 0,
  }

  if (change.action === 'blocked') {
    return {
      ...base,
      status: 'blocked',
      finishedAt: now().toISOString(),
      error: {
        code: 'DESTRUCTIVE_ACTION_BLOCKED',
        message: change.reason,
        retryable: false,
      },
    }
  }

  if (change.action === 'noop') {
    return { ...base, status: 'skipped', finishedAt: now().toISOString() }
  }

  const unmet = change.dependencies.filter((id) => !dependencySatisfied(records.get(id)))
  if (unmet.length > 0) {
    return {
      ...base,
      status: 'skipped',
      finishedAt: now().toISOString(),
      error: {
        code: 'PROVIDER_ERROR',
        message: `Skipped because dependencies were not satisfied: ${unmet.join(', ')}`,
        retryable: false,
        details: { dependencies: unmet },
      },
    }
  }

  const startedAt = now().toISOString()
  let attempts = 0
  let lastError: unknown = null

  while (attempts < retry.maxAttempts) {
    attempts += 1
    const timeout = AbortSignal.timeout(input.timeoutMs)
    const signal = input.signal === undefined ? timeout : AbortSignal.any([timeout, input.signal])

    try {
      const context = input.createContext({ change, attempt: attempts, signal })
      const result = await input.provider.applyChange(context, change)
      input.logger.info(
        { changeId: change.id, resourceType: change.resourceType, attempt: attempts },
        'change applied',
      )
      return {
        ...base,
        status: 'succeeded',
        attempts,
        startedAt,
        finishedAt: now().toISOString(),
        externalId: result.externalId ?? null,
        providerRequestId: result.providerRequestId ?? null,
        error: null,
      }
    } catch (error) {
      lastError = normalizeError(error, signal, input.timeoutMs)
      const retryable = DSPError.isDSPError(lastError) && lastError.retryable
      input.logger.warn(
        {
          changeId: change.id,
          attempt: attempts,
          retryable,
          code: DSPError.isDSPError(lastError) ? lastError.code : 'INTERNAL_ERROR',
        },
        'change failed',
      )
      if (!retryable || attempts >= retry.maxAttempts) break
      await sleep(backoffDelay(attempts, retry), input.signal)
    }
  }

  return {
    ...base,
    status: 'failed',
    attempts,
    startedAt,
    finishedAt: now().toISOString(),
    error: toErrorPayload(lastError),
  }
}

function normalizeError(error: unknown, signal: AbortSignal, timeoutMs: number): unknown {
  if (!signal.aborted) return error
  const reason = signal.reason as { name?: string } | undefined
  if (reason?.name === 'TimeoutError') {
    return new DSPError('PROVIDER_TIMEOUT', `Provider call exceeded ${timeoutMs}ms`, {
      retryable: true,
      details: { timeoutMs },
    })
  }
  return new DSPError('CANCELLED', 'Operation was cancelled', { cause: error })
}

function orderRecords(
  plan: DSPPlan,
  records: ReadonlyMap<string, ChangeExecutionRecord>,
): ChangeExecutionRecord[] {
  return plan.changes
    .map((change) => records.get(change.id))
    .filter((record): record is ChangeExecutionRecord => record !== undefined)
}

function commit(
  operation: OperationRecord,
  records: ReadonlyMap<string, ChangeExecutionRecord>,
  now: () => Date,
  cancelled: boolean,
): OperationRecord {
  const changes = [...records.values()]
  return {
    ...operation,
    changes: operation.changes.length > 0 ? reorder(operation, changes) : changes,
    status: cancelled ? 'cancelled' : finalStatus(changes),
    updatedAt: now().toISOString(),
  }
}

function reorder(
  operation: OperationRecord,
  changes: ChangeExecutionRecord[],
): ChangeExecutionRecord[] {
  const order = new Map(operation.changes.map((record, index) => [record.changeId, index]))
  return [...changes].sort(
    (a, b) =>
      (order.get(a.changeId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.changeId) ?? Number.MAX_SAFE_INTEGER),
  )
}

export function finalStatus(changes: readonly ChangeExecutionRecord[]): OperationStatus {
  const has = (status: ChangeStatus): boolean => changes.some((change) => change.status === status)
  const succeeded = changes.filter((change) => change.status === 'succeeded').length
  const incomplete =
    has('failed') ||
    has('blocked') ||
    changes.some((change) => change.status === 'skipped' && change.error != null)

  if (!incomplete) return 'completed'
  if (succeeded === 0 && has('failed')) return 'failed'
  return 'partially_completed'
}

/**
 * A dependency asks for a resource to exist before the dependent one is applied.
 *
 * Succeeding satisfies that. So does a `noop`: a noop means the resource is already
 * in the desired state, which is precisely what the dependency wanted. Requiring
 * `succeeded` alone meant that adding a child to a parent that already existed was
 * skipped — a new price under an existing product, a table in an existing database,
 * a record in an existing zone. A failed, blocked, or transitively skipped
 * dependency does not satisfy it.
 */
function dependencySatisfied(record: ChangeExecutionRecord | undefined): boolean {
  if (record === undefined) return false
  if (record.status === 'succeeded') return true
  return record.action === 'noop' && record.status === 'skipped'
}
