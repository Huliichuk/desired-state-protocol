export interface RetryOptions {
  /** Total attempts per change, including the first one. */
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  factor: number
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 5_000,
  factor: 2,
}

export const NO_RETRY: RetryOptions = {
  maxAttempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 0,
  factor: 1,
}

/**
 * Exponential backoff without jitter: the delay for a given attempt is a pure
 * function of the retry options, so execution timing stays reproducible in
 * tests and in incident reconstruction.
 */
export function backoffDelay(attempt: number, options: RetryOptions): number {
  if (attempt <= 1) return options.initialDelayMs
  const delay = options.initialDelayMs * options.factor ** (attempt - 1)
  return Math.min(Math.round(delay), options.maxDelayMs)
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
