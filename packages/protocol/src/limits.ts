import { canonicalize } from './canonical.js'
import { DSPError } from './types/errors.js'

export interface ProtocolLimits {
  maxDocumentBytes: number
  maxDocumentDepth: number
  maxResources: number
  maxChanges: number
  planTtlSeconds: number
  providerCallTimeoutMs: number
}

export const DEFAULT_LIMITS: ProtocolLimits = {
  maxDocumentBytes: 512 * 1024,
  maxDocumentDepth: 32,
  maxResources: 500,
  maxChanges: 1000,
  planTtlSeconds: 15 * 60,
  providerCallTimeoutMs: 30_000,
}

export function assertDocumentLimits(document: unknown, limits: ProtocolLimits): void {
  const serialized = canonicalize(document)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > limits.maxDocumentBytes) {
    throw new DSPError(
      'DOCUMENT_TOO_LARGE',
      `Desired State document is ${bytes} bytes, limit is ${limits.maxDocumentBytes}`,
      { details: { bytes, limit: limits.maxDocumentBytes } },
    )
  }

  const depth = valueDepth(document, limits.maxDocumentDepth + 1)
  if (depth > limits.maxDocumentDepth) {
    throw new DSPError(
      'DOCUMENT_TOO_DEEP',
      `Desired State document nests ${depth} levels, limit is ${limits.maxDocumentDepth}`,
      { details: { depth, limit: limits.maxDocumentDepth } },
    )
  }
}

export function valueDepth(value: unknown, ceiling = Number.MAX_SAFE_INTEGER): number {
  if (value === null || typeof value !== 'object') return 0
  if (value instanceof Date) return 0

  let deepest = 0
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  for (const child of children) {
    const depth = valueDepth(child, ceiling - 1)
    if (depth > deepest) deepest = depth
    if (deepest + 1 >= ceiling) break
  }
  return deepest + 1
}
