/**
 * A Desired State document describes the shape a system should have. A contract
 * describes what that shape was *for*.
 *
 * Without it, verification can only answer "does the world match the document",
 * which is not the same question as "did the change achieve what it was for". A
 * document that asks for an inactive subscription verifies perfectly and bills
 * nobody.
 */
export interface DesiredStateContract {
  /**
   * What the document is trying to achieve, in prose. Carried through plans,
   * operations and the audit log so a reviewer reads intent, not just a diff.
   */
  goal?: string

  /**
   * Bounds the client declares on its own document, checked at plan time against
   * the desired state.
   *
   * These are a self-check, NOT an access control. A client picks its own
   * constraints and can pick weak ones, exactly as it could claim a weak
   * environment. Operator-imposed limits belong in the policy bundle, which the
   * client cannot influence at all.
   */
  constraints?: ContractPredicate[]

  /**
   * Conditions that must hold once the change has been applied, checked against
   * the state the provider actually reports afterwards.
   */
  success?: ContractPredicate[]
}

export interface ContractPredicate {
  /** Stable identifier, so a result can be attributed to a rule. */
  id: string
  /** A CEL expression that MUST evaluate to a boolean. */
  expression: string
  /** Shown when the predicate does not hold. */
  message?: string
}

export interface PredicateResult {
  id: string
  /** Echoed so a stored plan explains itself without the original document. */
  expression: string
  satisfied: boolean
  message: string | null
  /**
   * Set when the expression could not be evaluated at all — a syntax error, an
   * unknown binding, a missing field, or a non-boolean result. An unevaluable
   * predicate is never reported as a plain `false`: "the answer is no" and "there
   * is no answer" are different, and conflating them hides broken contracts.
   */
  error: string | null
}

export interface ContractCheck {
  /** Echoed from the contract, or null when the document declared no goal. */
  goal: string | null
  predicates: PredicateResult[]
  /** True when every predicate was evaluated and every one held. */
  satisfied: boolean
}

export const EMPTY_CONTRACT_CHECK: ContractCheck = Object.freeze({
  goal: null,
  predicates: [],
  satisfied: true,
})

/** The single binding a contract predicate is evaluated against. */
export interface ContractBindings {
  /** Every resource in the projection: `{ type, key, attributes }`. */
  resources: Array<{
    type: string
    key: string
    attributes: Record<string, unknown>
  }>
}

export function contractIsEmpty(contract: DesiredStateContract | undefined): boolean {
  if (contract === undefined) return true
  return (
    contract.goal === undefined &&
    (contract.constraints ?? []).length === 0 &&
    (contract.success ?? []).length === 0
  )
}
