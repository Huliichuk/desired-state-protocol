import { describe, expect, it } from 'vitest'
import type { ContractPredicate, ResourceProjection } from '@dsp/protocol'
import {
  CONTRACT_LIMITS,
  bindingsFromProjection,
  evaluatePredicates,
  validateContract,
} from '@dsp/contract-engine'

const projection: ResourceProjection = {
  resources: [
    {
      resourceType: 'mock.subscription',
      key: 'mock.subscription/a@b.c',
      attributes: { user: 'a@b.c', plan: 'pro', amountCents: 2900, currency: 'eur', active: false },
    },
    {
      resourceType: 'mock.user',
      key: 'mock.user/a@b.c',
      attributes: { email: 'a@b.c', role: 'admin' },
    },
  ],
}

const predicate = (expression: string, id = 'p'): ContractPredicate => ({ id, expression })

const evaluate = (expression: string, on = projection) =>
  evaluatePredicates(undefined, [predicate(expression)], on).predicates[0]

describe('bindingsFromProjection', () => {
  it('exposes type, key and attributes and nothing else', () => {
    const bindings = bindingsFromProjection(projection)
    expect(Object.keys(bindings)).toEqual(['resources'])
    expect(Object.keys(bindings.resources[0] ?? {}).sort()).toEqual(['attributes', 'key', 'type'])
  })

  it('does not expose the environment, the actor or the clock', () => {
    // A document-supplied expression that could read the environment would look
    // like it was reasoning about trust. Only resources are in scope.
    const serialized = JSON.stringify(bindingsFromProjection(projection))
    for (const forbidden of ['environment', 'actor', 'tenant', 'now', 'policy']) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})

describe('evaluatePredicates', () => {
  it('reports a predicate that holds', () => {
    const result = evaluate('resources.exists(r, r.type == "mock.user")')
    expect(result).toMatchObject({ satisfied: true, error: null })
  })

  it('reports a predicate that does not hold', () => {
    const result = evaluate(
      'resources.exists(r, r.type == "mock.subscription" && r.attributes.active == true)',
    )
    expect(result).toMatchObject({ satisfied: false, error: null })
  })

  it('evaluates a numeric bound over a filtered subset', () => {
    const cap = (limit: number) =>
      evaluate(
        `resources.filter(r, r.type == "mock.subscription").all(s, s.attributes.amountCents <= ${limit})`,
      )
    expect(cap(10000)?.satisfied).toBe(true)
    expect(cap(1000)?.satisfied).toBe(false)
  })

  it('supports the standard macros', () => {
    expect(evaluate('size(resources) == 2')?.satisfied).toBe(true)
    expect(evaluate('resources.all(r, r.key != "")')?.satisfied).toBe(true)
    expect(evaluate('resources.exists_one(r, r.type == "mock.user")')?.satisfied).toBe(true)
  })

  it('distinguishes "the answer is no" from "there is no answer"', () => {
    const missingField = evaluate('resources.exists(r, r.attributes.nosuchfield == 1)')
    expect(missingField?.satisfied).toBe(false)
    expect(missingField?.error).toContain('nosuchfield')

    const plainlyFalse = evaluate('size(resources) == 99')
    expect(plainlyFalse?.satisfied).toBe(false)
    expect(plainlyFalse?.error).toBeNull()
  })

  it('reports an unknown binding as an error rather than as false', () => {
    const result = evaluate('somethingElse == 1')
    expect(result?.satisfied).toBe(false)
    expect(result?.error).not.toBeNull()
  })

  it('refuses a non-boolean result', () => {
    const result = evaluate('size(resources)')
    expect(result?.satisfied).toBe(false)
    expect(result?.error).toContain('must evaluate to a boolean')
  })

  it('never throws, whatever the expression', () => {
    for (const expression of ['(((', 'resources[', '1 +', '"unterminated', '']) {
      expect(() => evaluate(expression)).not.toThrow()
    }
  })

  it('is unsatisfied as a whole when any predicate errors', () => {
    const check = evaluatePredicates(
      'a goal',
      [predicate('true', 'ok'), predicate('r.nope', 'broken')],
      projection,
    )
    expect(check.satisfied).toBe(false)
    expect(check.predicates.map((p) => p.id)).toEqual(['ok', 'broken'])
  })

  it('echoes the goal, the expression and the message so a plan explains itself', () => {
    const check = evaluatePredicates(
      'the founder can be billed',
      [{ id: 'active', expression: 'false', message: 'nobody can be billed' }],
      projection,
    )
    expect(check.goal).toBe('the founder can be billed')
    expect(check.predicates[0]).toMatchObject({
      expression: 'false',
      message: 'nobody can be billed',
      satisfied: false,
    })
  })

  it('is satisfied when there is nothing to check', () => {
    expect(evaluatePredicates(undefined, [], projection).satisfied).toBe(true)
    expect(evaluatePredicates(undefined, undefined, projection)).toMatchObject({
      goal: null,
      predicates: [],
      satisfied: true,
    })
  })

  it('is satisfied for a goal with no predicates, and still carries the goal', () => {
    const check = evaluatePredicates('just intent', [], projection)
    expect(check).toMatchObject({ goal: 'just intent', satisfied: true })
  })

  it('is deterministic', () => {
    const once = evaluatePredicates('g', [predicate('size(resources) == 2')], projection)
    const twice = evaluatePredicates('g', [predicate('size(resources) == 2')], projection)
    expect(once).toEqual(twice)
  })

  it('sees an empty projection as an empty list rather than an error', () => {
    const result = evaluate('size(resources) == 0', { resources: [] })
    expect(result).toMatchObject({ satisfied: true, error: null })
  })
})

describe('validateContract', () => {
  it('accepts an absent contract', () => {
    expect(validateContract(undefined).valid).toBe(true)
  })

  it('accepts a well-formed contract', () => {
    const result = validateContract({
      goal: 'billing works',
      constraints: [predicate('size(resources) < 10', 'small')],
      success: [predicate('resources.exists(r, r.type == "mock.user")', 'has-user')],
    })
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('rejects an expression that is not valid CEL, with the path of the offender', () => {
    const result = validateContract({ success: [predicate('resources.exists(r,', 'broken')] })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toMatchObject({
      code: 'CONTRACT_PREDICATE_INVALID',
      path: 'contract.success[0].expression',
    })
  })

  it('rejects duplicate predicate ids, so a result can always be attributed', () => {
    const result = validateContract({
      constraints: [predicate('true', 'same'), predicate('false', 'same')],
    })
    expect(result.errors[0]?.path).toBe('contract.constraints[1].id')
  })

  it('bounds what a client can ask the runtime to evaluate', () => {
    const many = Array.from({ length: CONTRACT_LIMITS.maxPredicates + 1 }, (_unused, index) =>
      predicate('true', `p${index}`),
    )
    expect(validateContract({ constraints: many }).valid).toBe(false)

    const long = predicate('true || '.repeat(400) + 'true', 'long')
    expect(validateContract({ success: [long] }).valid).toBe(false)

    const goal = 'x'.repeat(CONTRACT_LIMITS.maxGoalLength + 1)
    expect(validateContract({ goal }).valid).toBe(false)
  })

  it('warns about a contract that declares nothing', () => {
    const result = validateContract({})
    expect(result.valid).toBe(true)
    expect(result.warnings[0]?.code).toBe('EMPTY_CONTRACT')
  })

  it('honours a custom base path', () => {
    const result = validateContract({ success: [predicate('((', 'x')] }, 'doc.contract')
    expect(result.errors[0]?.path).toBe('doc.contract.success[0].expression')
  })
})
