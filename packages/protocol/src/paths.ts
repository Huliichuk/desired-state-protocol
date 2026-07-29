/**
 * Attribute path helpers. DSP uses a dotted path notation with bracketed array
 * indices, e.g. `spec.prices[0].currency`.
 */

export function joinPath(parent: string, key: string): string {
  return parent.length === 0 ? key : `${parent}.${key}`
}

export function joinIndex(parent: string, index: number): string {
  return `${parent}[${index}]`
}

/**
 * Flattens a value into a map of leaf path -> leaf value. Empty objects and
 * empty arrays are kept as leaves so that "became empty" is a visible change.
 */
export function flattenValue(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>()
  walk(value, prefix, out)
  return out
}

function walk(value: unknown, path: string, out: Map<string, unknown>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(path, [])
      return
    }
    value.forEach((item, index) => walk(item, joinIndex(path, index), out))
    return
  }

  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== undefined,
    )
    if (entries.length === 0) {
      out.set(path, {})
      return
    }
    for (const [key, item] of entries) walk(item, joinPath(path, key), out)
    return
  }

  out.set(path, value)
}

export function getAtPath(source: unknown, path: string): unknown {
  if (path.length === 0) return source
  let current: unknown = source
  for (const segment of parsePath(path)) {
    if (current === null || current === undefined) return undefined
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[segment]
    } else {
      if (typeof current !== 'object' || Array.isArray(current)) return undefined
      current = (current as Record<string, unknown>)[segment]
    }
  }
  return current
}

export function parsePath(path: string): Array<string | number> {
  const segments: Array<string | number> = []
  let buffer = ''

  const flush = (): void => {
    if (buffer.length > 0) {
      segments.push(buffer)
      buffer = ''
    }
  }

  for (let index = 0; index < path.length; index += 1) {
    const char = path[index]
    if (char === '.') {
      flush()
    } else if (char === '[') {
      flush()
      const end = path.indexOf(']', index)
      if (end === -1) {
        buffer += char
        continue
      }
      segments.push(Number.parseInt(path.slice(index + 1, end), 10))
      index = end
    } else {
      buffer += char
    }
  }
  flush()
  return segments
}

/**
 * Removes array indices so that `prices[0].currency` matches the declared
 * immutable field `prices[].currency`.
 */
export function normalizePathPattern(path: string): string {
  return path.replace(/\[\d+\]/g, '[]')
}

/**
 * True when `path` is covered by `pattern`. A pattern matches the path itself
 * and everything nested under it. `[]` matches any array index and a trailing
 * `*` matches any suffix.
 */
export function pathMatches(path: string, pattern: string): boolean {
  const normalizedPath = normalizePathPattern(path)
  const normalizedPattern = normalizePathPattern(pattern)

  if (normalizedPattern.endsWith('*')) {
    return normalizedPath.startsWith(normalizedPattern.slice(0, -1))
  }
  if (normalizedPath === normalizedPattern) return true
  return (
    normalizedPath.startsWith(`${normalizedPattern}.`) ||
    normalizedPath.startsWith(`${normalizedPattern}[`)
  )
}

export function pathMatchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pathMatches(path, pattern))
}
