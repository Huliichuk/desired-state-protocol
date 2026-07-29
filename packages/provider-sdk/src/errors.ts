import { DSPError, type DSPErrorCode } from '@dsp/protocol'

/**
 * Signals a failure inside a provider. `retryable` drives the execution
 * engine's backoff: everything else fails the change immediately.
 */
export function providerError(
  message: string,
  options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
): DSPError {
  const opts: { retryable: boolean; details?: Record<string, unknown>; cause?: unknown } = {
    retryable: options.retryable ?? false,
  }
  if (options.details !== undefined) opts.details = options.details
  if (options.cause !== undefined) opts.cause = options.cause
  return new DSPError('PROVIDER_ERROR', message, opts)
}

export function providerTimeout(message: string, details?: Record<string, unknown>): DSPError {
  return new DSPError('PROVIDER_TIMEOUT', message, {
    retryable: true,
    ...(details === undefined ? {} : { details }),
  })
}

export function unsupportedOperation(message: string, details?: Record<string, unknown>): DSPError {
  return new DSPError('UNSUPPORTED_OPERATION', message, details === undefined ? {} : { details })
}

export function notImplemented(what: string): DSPError {
  return new DSPError('NOT_IMPLEMENTED', `${what} is not implemented`)
}

export function destructiveBlocked(message: string, details?: Record<string, unknown>): DSPError {
  return new DSPError(
    'DESTRUCTIVE_ACTION_BLOCKED',
    message,
    details === undefined ? {} : { details },
  )
}

export function isRetryable(error: unknown): boolean {
  return DSPError.isDSPError(error) ? error.retryable : false
}

export function errorCodeOf(error: unknown): DSPErrorCode {
  return DSPError.isDSPError(error) ? error.code : 'INTERNAL_ERROR'
}
