import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js'
import type { JsonSchema } from './types/common.js'
import type { ValidationIssue, ValidationResult } from './types/validation.js'

export interface SchemaValidator {
  validate(value: unknown): ValidationResult
}

export interface SchemaValidatorOptions {
  /** Prefix used in reported paths, e.g. `spec`. */
  basePath?: string
  /** Error code reported for schema violations. */
  code?: string
}

/**
 * Compiles a JSON Schema (draft 2020-12) into a validator that speaks the DSP
 * validation vocabulary.
 */
export function createSchemaValidator(
  schema: JsonSchema,
  options: SchemaValidatorOptions = {},
): SchemaValidator {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
    // `format` is an annotation in JSON Schema 2020-12 and the published DSP
    // schemas use it as documentation. Silence ajv's per-format notice while
    // keeping anything it genuinely warns about.
    logger: {
      log: () => undefined,
      warn: (...args: unknown[]) => {
        const message = args.map(String).join(' ')
        if (message.includes('unknown format')) return
        process.emitWarning(message)
      },
      error: (...args: unknown[]) => process.emitWarning(args.map(String).join(' ')),
    },
  })
  const validate: ValidateFunction = ajv.compile(schema)
  const basePath = options.basePath ?? ''
  const code = options.code ?? 'SCHEMA_VALIDATION_FAILED'

  return {
    validate(value: unknown): ValidationResult {
      const valid = validate(value)
      if (valid) return { valid: true, errors: [], warnings: [] }
      return {
        valid: false,
        errors: (validate.errors ?? []).map((error) => toIssue(error, basePath, code)),
        warnings: [],
      }
    },
  }
}

function toIssue(error: ErrorObject, basePath: string, code: string): ValidationIssue {
  return {
    code,
    path: toPath(error, basePath),
    message: describe(error),
  }
}

function toPath(error: ErrorObject, basePath: string): string {
  const pointer = error.instancePath
  const converted = pointer
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce(
      (acc, segment) =>
        /^\d+$/.test(segment) ? `${acc}[${segment}]` : acc === '' ? segment : `${acc}.${segment}`,
      '',
    )

  const missing =
    error.keyword === 'required' && typeof error.params['missingProperty'] === 'string'
      ? String(error.params['missingProperty'])
      : null

  const parts = [basePath, converted].filter((part) => part.length > 0)
  const path = parts.join('.')
  if (missing === null) return path
  return path.length === 0 ? missing : `${path}.${missing}`
}

function describe(error: ErrorObject): string {
  if (error.keyword === 'required') {
    return `Missing required property "${String(error.params['missingProperty'])}"`
  }
  if (error.keyword === 'additionalProperties') {
    return `Unknown property "${String(error.params['additionalProperty'])}"`
  }
  if (error.keyword === 'enum') {
    const allowed = error.params['allowedValues']
    return `Value must be one of: ${Array.isArray(allowed) ? allowed.join(', ') : 'the allowed set'}`
  }
  return error.message ?? 'Value does not match the schema'
}
