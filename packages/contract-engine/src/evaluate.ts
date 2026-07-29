import { CelScalar, isCelError, listType, mapType, parse, run } from '@bufbuild/cel'
import {
  EMPTY_CONTRACT_CHECK,
  contractIsEmpty,
  type ContractCheck,
  type ContractPredicate,
  type DesiredStateContract,
  type PredicateResult,
  type ResourceProjection,
  type ValidationIssue,
  type ValidationResult,
} from '@dsp/protocol'
import { bindingsFromProjection, celBindings } from './bindings.js'

/**
 * The only binding a contract predicate can see.
 *
 * Deliberately one variable. A predicate cannot reach the environment, the actor,
 * the policy bundle or the clock: it asserts things about resources and nothing
 * else. A document-supplied expression able to read the environment would look like
 * it was reasoning about trust, and it must never be able to.
 *
 * Not exported: its inferred type carries a private brand from the CEL library that
 * cannot be named in a declaration file.
 */
const CONTRACT_ENV = {
  variables: {
    resources: listType(mapType(CelScalar.STRING, CelScalar.DYN)),
  },
} as const

/**
 * Bounds on contract size. A predicate is evaluated by the runtime on behalf of a
 * client, so the client does not get to decide how much work that is.
 */
export const CONTRACT_LIMITS = {
  maxPredicates: 32,
  maxExpressionLength: 2048,
  maxGoalLength: 512,
} as const

/**
 * Checks a contract without evaluating it, so a broken expression is reported by
 * `validate` rather than discovered when a plan is built.
 */
export function validateContract(
  contract: DesiredStateContract | undefined,
  basePath = 'contract',
): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  if (contract === undefined) return { valid: true, errors, warnings }

  if (contract.goal !== undefined && contract.goal.length > CONTRACT_LIMITS.maxGoalLength) {
    errors.push({
      code: 'CONTRACT_PREDICATE_INVALID',
      path: `${basePath}.goal`,
      message: `A goal may be at most ${CONTRACT_LIMITS.maxGoalLength} characters`,
    })
  }

  for (const [group, predicates] of [
    ['constraints', contract.constraints ?? []],
    ['success', contract.success ?? []],
  ] as const) {
    if (predicates.length > CONTRACT_LIMITS.maxPredicates) {
      errors.push({
        code: 'CONTRACT_PREDICATE_INVALID',
        path: `${basePath}.${group}`,
        message: `At most ${CONTRACT_LIMITS.maxPredicates} predicates are allowed, found ${predicates.length}`,
      })
    }

    const seen = new Set<string>()
    predicates.forEach((predicate, index) => {
      const path = `${basePath}.${group}[${index}]`

      if (seen.has(predicate.id)) {
        errors.push({
          code: 'CONTRACT_PREDICATE_INVALID',
          path: `${path}.id`,
          message: `Duplicate predicate id "${predicate.id}"`,
        })
      }
      seen.add(predicate.id)

      if (predicate.expression.length > CONTRACT_LIMITS.maxExpressionLength) {
        errors.push({
          code: 'CONTRACT_PREDICATE_INVALID',
          path: `${path}.expression`,
          message: `An expression may be at most ${CONTRACT_LIMITS.maxExpressionLength} characters`,
        })
        return
      }

      const syntax = parseError(predicate.expression)
      if (syntax !== null) {
        errors.push({
          code: 'CONTRACT_PREDICATE_INVALID',
          path: `${path}.expression`,
          message: syntax,
        })
      }
    })
  }

  if (contractIsEmpty(contract)) {
    warnings.push({
      code: 'EMPTY_CONTRACT',
      path: basePath,
      message:
        'The contract declares no goal, constraints or success conditions, so it adds nothing',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}

function parseError(expression: string): string | null {
  try {
    parse(expression)
    return null
  } catch (error) {
    return `Not a valid CEL expression: ${describe(error)}`
  }
}

/**
 * Evaluates one group of predicates against a projection.
 *
 * Total by construction: a predicate that cannot be evaluated is reported with an
 * `error`, never as a plain `false`. "The answer is no" and "there is no answer"
 * are different findings, and a contract that silently reads as unsatisfied
 * because of a typo is worse than one that says the typo out loud.
 */
export function evaluatePredicates(
  goal: string | undefined,
  predicates: readonly ContractPredicate[] | undefined,
  projection: ResourceProjection,
): ContractCheck {
  const list = predicates ?? []
  if (goal === undefined && list.length === 0) return EMPTY_CONTRACT_CHECK

  const bindings = celBindings(bindingsFromProjection(projection))
  const results = list.map((predicate) => evaluateOne(predicate, bindings))

  return {
    goal: goal ?? null,
    predicates: results,
    satisfied: results.every((result) => result.satisfied && result.error === null),
  }
}

function evaluateOne(
  predicate: ContractPredicate,
  bindings: Record<string, unknown>,
): PredicateResult {
  const base = {
    id: predicate.id,
    expression: predicate.expression,
    message: predicate.message ?? null,
  }

  let outcome: unknown
  try {
    outcome = run(predicate.expression, bindings as never, CONTRACT_ENV as never)
  } catch (error) {
    // `run` is documented as total, but a contract must not be able to crash a plan.
    return { ...base, satisfied: false, error: describe(error) }
  }

  if (isCelError(outcome)) {
    return { ...base, satisfied: false, error: describe(outcome) }
  }

  if (typeof outcome !== 'boolean') {
    return {
      ...base,
      satisfied: false,
      error: `Expression must evaluate to a boolean, got ${describeType(outcome)}`,
    }
  }

  return { ...base, satisfied: outcome, error: null }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'object' && value !== null && 'message' in value) {
    return String((value as { message: unknown }).message)
  }
  return String(value)
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'bigint') return 'int'
  return typeof value
}
