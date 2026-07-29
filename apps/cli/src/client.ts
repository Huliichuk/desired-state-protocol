import {
  DSPError,
  type AuditChainVerification,
  type AuditEvent,
  type ApprovalRecord,
  type CurrentState,
  type DSPErrorPayload,
  type DSPManifest,
  type DSPPlan,
  type KindDefinition,
  type OperationRecord,
  type ValidationResult,
  type VerificationResult,
} from '@dsp/protocol'
import type { PlanOptions } from '@dsp/core'

export interface ClientOptions {
  server: string
  token?: string
  actorId?: string
  actorType?: 'human' | 'agent' | 'system'
  timeoutMs?: number
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  headers?: Record<string, string>
}

/**
 * Thin HTTP client. It deliberately does no retrying: apply is guarded by an
 * idempotency key on the server, and silently retrying a mutation from the
 * client is exactly the behaviour DSP exists to prevent.
 */
export class DspClient {
  readonly #base: string
  readonly #options: ClientOptions

  constructor(options: ClientOptions) {
    this.#base = options.server.replace(/\/+$/, '')
    this.#options = options
  }

  get server(): string {
    return this.#base
  }

  async manifest(): Promise<DSPManifest> {
    return this.#request<DSPManifest>('/.well-known/dsp')
  }

  async health(): Promise<Record<string, unknown>> {
    return this.#request<Record<string, unknown>>('/health')
  }

  async resourceTypes(): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.#request('/v1/resource-types')
  }

  async kinds(): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.#request('/v1/kinds')
  }

  async kindSchema(kind: string): Promise<KindDefinition['specSchema']> {
    return this.#request(`/v1/kinds/${encodeURIComponent(kind)}/schema`)
  }

  async validate(desiredState: unknown): Promise<ValidationResult> {
    return this.#request('/v1/validate', { method: 'POST', body: { desiredState } })
  }

  async inspect(desiredState: unknown): Promise<CurrentState> {
    return this.#request('/v1/inspect', { method: 'POST', body: { desiredState } })
  }

  async plan(desiredState: unknown, options?: PlanOptions): Promise<DSPPlan> {
    return this.#request('/v1/plans', {
      method: 'POST',
      body: options === undefined ? { desiredState } : { desiredState, options },
    })
  }

  async getPlan(planId: string): Promise<DSPPlan> {
    return this.#request(`/v1/plans/${encodeURIComponent(planId)}`)
  }

  async approve(
    planId: string,
    body: { approvedBy: string; reason: string; planHash: string },
  ): Promise<ApprovalRecord> {
    return this.#request(`/v1/plans/${encodeURIComponent(planId)}/approve`, {
      method: 'POST',
      body,
    })
  }

  async apply(
    planId: string,
    input: { idempotencyKey: string; ifMatch?: string },
  ): Promise<OperationRecord> {
    return this.#request(`/v1/plans/${encodeURIComponent(planId)}/apply`, {
      method: 'POST',
      headers: {
        'idempotency-key': input.idempotencyKey,
        ...(input.ifMatch === undefined ? {} : { 'if-match': input.ifMatch }),
      },
    })
  }

  async operation(operationId: string): Promise<OperationRecord> {
    return this.#request(`/v1/operations/${encodeURIComponent(operationId)}`)
  }

  async verify(operationId: string): Promise<VerificationResult> {
    return this.#request(`/v1/operations/${encodeURIComponent(operationId)}/verify`, {
      method: 'POST',
    })
  }

  async cancel(operationId: string): Promise<OperationRecord> {
    return this.#request(`/v1/operations/${encodeURIComponent(operationId)}/cancel`, {
      method: 'POST',
    })
  }

  async audit(query: { limit?: number; planId?: string; operationId?: string } = {}): Promise<{
    items: AuditEvent[]
  }> {
    const params = new URLSearchParams()
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    if (query.planId !== undefined) params.set('planId', query.planId)
    if (query.operationId !== undefined) params.set('operationId', query.operationId)
    const suffix = params.size === 0 ? '' : `?${params.toString()}`
    return this.#request(`/v1/audit${suffix}`)
  }

  async verifyAuditChain(): Promise<AuditChainVerification> {
    return this.#request('/v1/audit/verify')
  }

  async #request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-dsp-actor-type': this.#options.actorType ?? 'human',
      'x-dsp-actor-id': this.#options.actorId ?? 'dsp-cli',
      ...options.headers,
    }
    if (this.#options.token !== undefined) {
      headers['authorization'] = `Bearer ${this.#options.token}`
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json'

    let response: Response
    try {
      response = await fetch(`${this.#base}${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 60_000),
      })
    } catch (error) {
      throw new DSPError('PROVIDER_ERROR', `Could not reach the DSP server at ${this.#base}`, {
        cause: error,
        retryable: true,
        details: { server: this.#base, path },
      })
    }

    const text = await response.text()
    const payload = text.length === 0 ? null : safeJson(text)

    if (!response.ok) {
      throw fromErrorBody(payload, response.status, path)
    }

    return payload as T
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function fromErrorBody(payload: unknown, status: number, path: string): DSPError {
  const body = payload as { error?: Partial<DSPErrorPayload> } | null
  const error = body?.error

  if (error?.code !== undefined && error.message !== undefined) {
    return new DSPError(error.code, error.message, {
      retryable: error.retryable ?? false,
      httpStatus: status,
      ...(error.details === undefined ? {} : { details: error.details }),
    })
  }

  return new DSPError('INTERNAL_ERROR', `Request to ${path} failed with HTTP ${status}`, {
    httpStatus: status,
    details: { status },
  })
}
