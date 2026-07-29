export const DSP_ERROR_CODES = [
  'VALIDATION_FAILED',
  'SCHEMA_VALIDATION_FAILED',
  'IMMUTABLE_FIELD_CHANGED',
  'UNKNOWN_KIND',
  'UNKNOWN_RESOURCE_TYPE',
  'PROVIDER_NOT_FOUND',
  'PROVIDER_ERROR',
  'PROVIDER_TIMEOUT',
  'SECRET_NOT_FOUND',
  'SECRET_ACCESS_DENIED',
  'POLICY_DENIED',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'PLAN_NOT_FOUND',
  'PLAN_EXPIRED',
  'PLAN_NOT_EXECUTABLE',
  'PLAN_HASH_MISMATCH',
  'STATE_DRIFT_DETECTED',
  'OPERATION_NOT_FOUND',
  'OPERATION_ALREADY_RUNNING',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_CONFLICT',
  'DESTRUCTIVE_ACTION_BLOCKED',
  'DEPENDENCY_CYCLE_DETECTED',
  'DOCUMENT_TOO_LARGE',
  'DOCUMENT_TOO_DEEP',
  'TOO_MANY_RESOURCES',
  'TOO_MANY_CHANGES',
  'UNSUPPORTED_OPERATION',
  'NOT_IMPLEMENTED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'CANCELLED',
  'VERIFICATION_FAILED',
  'INTERNAL_ERROR',
] as const

export type DSPErrorCode = (typeof DSP_ERROR_CODES)[number]

export interface DSPErrorPayload {
  code: DSPErrorCode
  message: string
  retryable: boolean
  details?: Record<string, unknown>
  requestId?: string
}

export interface DSPErrorResponse {
  error: DSPErrorPayload
}

const DEFAULT_HTTP_STATUS: Record<DSPErrorCode, number> = {
  VALIDATION_FAILED: 422,
  SCHEMA_VALIDATION_FAILED: 422,
  IMMUTABLE_FIELD_CHANGED: 422,
  UNKNOWN_KIND: 404,
  UNKNOWN_RESOURCE_TYPE: 404,
  PROVIDER_NOT_FOUND: 404,
  PROVIDER_ERROR: 502,
  PROVIDER_TIMEOUT: 504,
  SECRET_NOT_FOUND: 400,
  SECRET_ACCESS_DENIED: 403,
  POLICY_DENIED: 403,
  APPROVAL_REQUIRED: 409,
  APPROVAL_INVALID: 409,
  PLAN_NOT_FOUND: 404,
  PLAN_EXPIRED: 409,
  PLAN_NOT_EXECUTABLE: 409,
  PLAN_HASH_MISMATCH: 409,
  STATE_DRIFT_DETECTED: 409,
  OPERATION_NOT_FOUND: 404,
  OPERATION_ALREADY_RUNNING: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  DESTRUCTIVE_ACTION_BLOCKED: 403,
  DEPENDENCY_CYCLE_DETECTED: 422,
  DOCUMENT_TOO_LARGE: 413,
  DOCUMENT_TOO_DEEP: 422,
  TOO_MANY_RESOURCES: 422,
  TOO_MANY_CHANGES: 422,
  UNSUPPORTED_OPERATION: 501,
  NOT_IMPLEMENTED: 501,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CANCELLED: 409,
  VERIFICATION_FAILED: 200,
  INTERNAL_ERROR: 500,
}

export interface DSPErrorOptions {
  retryable?: boolean
  details?: Record<string, unknown>
  httpStatus?: number
  cause?: unknown
}

export class DSPError extends Error {
  readonly code: DSPErrorCode
  readonly retryable: boolean
  readonly details: Record<string, unknown> | undefined
  readonly httpStatus: number

  constructor(code: DSPErrorCode, message: string, options: DSPErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DSPError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details
    this.httpStatus = options.httpStatus ?? DEFAULT_HTTP_STATUS[code]
  }

  toPayload(requestId?: string): DSPErrorPayload {
    const payload: DSPErrorPayload = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    }
    if (this.details !== undefined) payload.details = this.details
    if (requestId !== undefined) payload.requestId = requestId
    return payload
  }

  static isDSPError(value: unknown): value is DSPError {
    return value instanceof DSPError
  }
}

export function defaultHttpStatusFor(code: DSPErrorCode): number {
  return DEFAULT_HTTP_STATUS[code]
}

/**
 * Converts an unknown thrown value into a DSP error payload without leaking
 * stack traces or provider internals to the caller.
 */
export function toErrorPayload(error: unknown, requestId?: string): DSPErrorPayload {
  if (DSPError.isDSPError(error)) return error.toPayload(requestId)
  const payload: DSPErrorPayload = {
    code: 'INTERNAL_ERROR',
    message: 'An unexpected internal error occurred',
    retryable: false,
  }
  if (requestId !== undefined) payload.requestId = requestId
  return payload
}
