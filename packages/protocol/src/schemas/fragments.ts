import type { JsonSchema } from '../types/common.js'

/**
 * Schema fragments shared by more than one published document.
 *
 * Kept as TypeScript rather than a sixth published file: these are pieces of the
 * documents that are published, not documents in their own right, and inlining them
 * keeps each published schema self-contained for a client that fetches only one.
 */

const predicate: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'expression'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    expression: { type: 'string', minLength: 1, maxLength: 2048 },
    message: { type: 'string', maxLength: 2048 },
  },
}

/** `contract` as it appears in a Desired State document. */
export const contractSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    goal: { type: 'string', maxLength: 512 },
    constraints: { type: 'array', maxItems: 32, items: predicate },
    success: { type: 'array', maxItems: 32, items: predicate },
  },
}

const predicateResult: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'expression', 'satisfied', 'message', 'error'],
  properties: {
    id: { type: 'string' },
    expression: { type: 'string' },
    satisfied: { type: 'boolean' },
    message: { type: ['string', 'null'] },
    // Non-null when the predicate could not be evaluated at all, which is a
    // different finding from evaluating to false.
    error: { type: ['string', 'null'] },
  },
}

/** An evaluated contract, as it appears in a plan and in a verification result. */
export const contractCheckSchema: JsonSchema = {
  oneOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['goal', 'predicates', 'satisfied'],
      properties: {
        goal: { type: ['string', 'null'] },
        predicates: { type: 'array', items: predicateResult },
        satisfied: { type: 'boolean' },
      },
    },
  ],
}
