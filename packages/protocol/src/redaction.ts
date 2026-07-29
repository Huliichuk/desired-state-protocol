import { pathMatchesAny, joinIndex, joinPath } from './paths.js'

export const REDACTED = '[REDACTED]'

/**
 * Property names whose values are always removed. Matched case-insensitively
 * against the whole key.
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-api-key$/i,
  /api[-_]?key/i,
  /access[-_]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passphrase/i,
  /private[-_]?key/i,
  /credential/i,
  /signature/i,
  /^session$/i,
  /^auth$/i,
]

/**
 * Value shapes that are secrets regardless of the key they appear under.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe secret / restricted keys
  /\bwhsec_[A-Za-z0-9]{10,}/g, // Stripe webhook signing secrets
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, // JWTs
  /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}={0,2}/gi,
]

export interface RedactionOptions {
  /** Extra attribute paths to redact, e.g. a resource type's sensitiveFields. */
  paths?: readonly string[]
  /** Extra literal values to redact wherever they appear. */
  values?: readonly string[]
  /** Path prefix used when matching `paths`. */
  basePath?: string
}

/**
 * Removes secrets from an arbitrary value before it reaches a plan, an audit
 * event, an HTTP response, a log line or the CLI.
 *
 * Redaction is deliberately aggressive: a false positive costs readability, a
 * false negative leaks a credential.
 */
export function redactSensitiveData(input: unknown, options: RedactionOptions = {}): unknown {
  const literals = (options.values ?? []).filter((value) => value.length >= 4)
  return redactValue(input, options.basePath ?? '', options.paths ?? [], literals, new WeakSet())
}

function redactValue(
  value: unknown,
  path: string,
  paths: readonly string[],
  literals: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return redactString(value, literals)
  if (value === null || typeof value !== 'object') return value

  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactValue(item, joinIndex(path, index), paths, literals, seen),
    )
  }

  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message, literals) }
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const childPath = joinPath(path, key)
    if (isSensitiveKey(key) || (paths.length > 0 && pathMatchesAny(childPath, paths))) {
      out[key] = REDACTED
      continue
    }
    out[key] = redactValue(item, childPath, paths, literals, seen)
  }
  return out
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

export function redactString(value: string, literals: readonly string[] = []): string {
  let out = value
  for (const literal of literals) {
    if (literal.length >= 4) out = out.split(literal).join(REDACTED)
  }
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), REDACTED)
  }
  return out
}

/**
 * True when the value still contains something that looks like a credential.
 * Used by the secret-leakage tests and by the server before it writes a body.
 */
export function containsSensitiveData(value: unknown): boolean {
  const serialized = safeStringify(value)
  return SENSITIVE_VALUE_PATTERNS.some((pattern) =>
    new RegExp(pattern.source, pattern.flags).test(serialized),
  )
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
