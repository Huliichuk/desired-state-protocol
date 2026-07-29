import type { DesiredStateDocument, ProtocolLimits } from '@dsp/protocol'
import type { SecretResolver } from '@dsp/secret-store'
import type { Logger } from './logger.js'

export interface ProviderContext {
  /** Deployment environment, e.g. `test` or `production`. */
  environment: string
  namespace: string
  logger: Logger
  /** Scoped secret access. Providers never see the underlying store. */
  secrets: SecretResolver
  /** Aborted on timeout or cancellation. Providers MUST honour it. */
  signal: AbortSignal
  limits: ProtocolLimits
  /** Injected clock so that provider behaviour stays testable and deterministic. */
  now(): Date
}

export interface ProviderExecutionContext extends ProviderContext {
  operationId: string
  idempotencyKey: string
  /** 1-based attempt counter for the current change. */
  attempt: number
  /**
   * The Desired State document the plan was built from. A change carries the
   * target attributes but not the document-level configuration (which account,
   * which credentials), so providers need both.
   */
  desired: DesiredStateDocument
}

export function assertNotAborted(context: Pick<ProviderContext, 'signal'>): void {
  context.signal.throwIfAborted()
}
