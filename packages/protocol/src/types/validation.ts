export interface ValidationIssue {
  code: string
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

export function validationOk(warnings: ValidationIssue[] = []): ValidationResult {
  return { valid: true, errors: [], warnings }
}

export function mergeValidationResults(...results: ValidationResult[]): ValidationResult {
  const errors = results.flatMap((result) => result.errors)
  const warnings = results.flatMap((result) => result.warnings)
  return { valid: errors.length === 0, errors, warnings }
}
