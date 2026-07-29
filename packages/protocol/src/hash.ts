import { createHash } from 'node:crypto'
import { canonicalize } from './canonical.js'

export const HASH_ALGORITHM = 'sha256'
export const HASH_PREFIX = `${HASH_ALGORITHM}:`

export function sha256Hex(input: string | Uint8Array): string {
  return createHash(HASH_ALGORITHM).update(input).digest('hex')
}

/**
 * Prefixed digest of the canonical JSON form: `sha256:<hex>`.
 */
export function hashCanonical(value: unknown): string {
  return `${HASH_PREFIX}${sha256Hex(canonicalize(value))}`
}

export function isHash(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value)
}

export function shortHash(hash: string, length = 12): string {
  return hash.startsWith(HASH_PREFIX)
    ? hash.slice(HASH_PREFIX.length, HASH_PREFIX.length + length)
    : hash.slice(0, length)
}

/**
 * Constant-time comparison for hash strings, so that hash checks do not leak
 * information through timing.
 */
export function hashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}
