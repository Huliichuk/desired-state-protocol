import { DSPError } from './types/errors.js'

/**
 * Canonical JSON serialization, following RFC 8785 (JCS):
 *
 *   - object keys are sorted by UTF-16 code unit
 *   - arrays keep their order
 *   - numbers use the ECMAScript number-to-string algorithm
 *   - `undefined` object properties are dropped
 *
 * Every DSP hash is computed over this representation, which is what makes
 * plan hashes stable across processes, machines and languages.
 */
export function canonicalize(value: unknown): string {
  return write(value, 0)
}

const MAX_DEPTH = 100

function write(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new DSPError('DOCUMENT_TOO_DEEP', `JSON nesting exceeds ${MAX_DEPTH} levels`)
  }

  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return writeNumber(value)
    case 'string':
      return JSON.stringify(value)
    case 'bigint':
      throw new DSPError('VALIDATION_FAILED', 'BigInt values cannot be canonicalized')
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new DSPError(
        'VALIDATION_FAILED',
        `Value of type ${typeof value} cannot be canonicalized`,
      )
    case 'object':
      break
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString())

  if (Array.isArray(value)) {
    const items = value.map((item) => (item === undefined ? 'null' : write(item, depth + 1)))
    return `[${items.join(',')}]`
  }

  const source = value as Record<string, unknown>
  const keys = Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .sort()

  const entries = keys.map((key) => `${JSON.stringify(key)}:${write(source[key], depth + 1)}`)
  return `{${entries.join(',')}}`
}

function writeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new DSPError('VALIDATION_FAILED', `Non-finite number cannot be canonicalized: ${value}`)
  }
  // `-0` and `0` are the same JSON value; normalize so hashes agree.
  return Object.is(value, -0) ? '0' : String(value)
}

/**
 * Returns a structurally identical value with all object keys sorted, useful
 * when a canonical *object* rather than a canonical string is needed.
 */
export function canonicalValue<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T
}

/**
 * Structural equality based on the canonical form.
 */
export function canonicalEquals(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b)
}
