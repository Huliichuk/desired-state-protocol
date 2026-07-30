import { providerError, providerTimeout } from '@dsp/provider-sdk'

export interface StripeRequest {
  method: 'GET' | 'POST' | 'DELETE'
  /** Path only, e.g. `/v1/products`. Never a full URL. */
  path: string
  params?: Record<string, unknown>
  apiKey: string
  idempotencyKey?: string
  signal: AbortSignal
}

export interface StripeTransport {
  request<T>(input: StripeRequest): Promise<T>
}

/**
 * The base URL is a constant, not configuration and never a value from a Desired
 * State document. A provider that took its host from the document would let a
 * client point the runtime — and the credential it holds — at an arbitrary server.
 */
const STRIPE_BASE_URL = 'https://api.stripe.com'

/** Pinned so a Stripe API change cannot silently alter what a plan means. */
const STRIPE_API_VERSION = '2025-08-27.basil'

/**
 * Stripe takes form-encoded bodies, with nested values as `metadata[key]` and
 * `recurring[interval]`.
 */
export function encodeParams(params: Record<string, unknown>, prefix = ''): string[] {
  const parts: string[] = []

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    const name = prefix === '' ? key : `${prefix}[${key}]`

    if (value === null) {
      // Stripe clears a field when it is sent empty.
      parts.push(`${encodeURIComponent(name)}=`)
      continue
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(...encodeParams(value as Record<string, unknown>, name))
      continue
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        parts.push(`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(String(item))}`)
      })
      continue
    }
    parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
  }

  return parts
}

interface StripeErrorBody {
  error?: { type?: string; code?: string; message?: string; param?: string }
}

/** Stripe error classes that are worth another attempt. */
const RETRYABLE_STATUS = new Set([409, 429, 500, 502, 503, 504])

export class FetchStripeTransport implements StripeTransport {
  readonly #baseUrl: string

  constructor(baseUrl: string = STRIPE_BASE_URL) {
    this.#baseUrl = baseUrl
  }

  async request<T>(input: StripeRequest): Promise<T> {
    const encoded = encodeParams(input.params ?? {})
    const isBodyMethod = input.method === 'POST'
    const query = !isBodyMethod && encoded.length > 0 ? `?${encoded.join('&')}` : ''

    const headers: Record<string, string> = {
      authorization: `Bearer ${input.apiKey}`,
      'stripe-version': STRIPE_API_VERSION,
    }
    if (isBodyMethod) headers['content-type'] = 'application/x-www-form-urlencoded'
    // Stripe deduplicates by this header, so a retried attempt cannot double-charge
    // or double-create.
    if (input.idempotencyKey !== undefined) headers['idempotency-key'] = input.idempotencyKey

    let response: Response
    try {
      response = await fetch(`${this.#baseUrl}${input.path}${query}`, {
        method: input.method,
        headers,
        body: isBodyMethod ? encoded.join('&') : undefined,
        signal: input.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw providerTimeout('Stripe did not respond within the allotted time')
      }
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw providerError(`Could not reach Stripe: ${describe(error)}`, { retryable: true })
    }

    const text = await response.text()
    const body: unknown = text === '' ? {} : safeParse(text)

    if (!response.ok) {
      const detail = (body as StripeErrorBody).error
      throw providerError(
        `Stripe rejected ${input.method} ${input.path}: ${detail?.message ?? response.statusText}`,
        {
          retryable: RETRYABLE_STATUS.has(response.status),
          // The message and param are safe to surface; the request body is not,
          // because it may carry the values the document supplied.
          details: {
            status: response.status,
            type: detail?.type,
            code: detail?.code,
            param: detail?.param,
          },
        },
      )
    }

    return body as T
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw providerError('Stripe returned a body that is not JSON', { retryable: true })
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
