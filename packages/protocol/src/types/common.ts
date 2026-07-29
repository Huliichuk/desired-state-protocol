export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'] as const

export type ActorType = 'human' | 'agent' | 'system'

export interface Actor {
  type: ActorType
  id: string
}

/**
 * A JSON Schema document. Kept structural on purpose: DSP treats provider
 * schemas as opaque data and hands them to a validator.
 */
export type JsonSchema = Record<string, unknown>

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * Compares two risk levels. Returns a positive number when `a` is riskier.
 */
export function compareRisk(a: RiskLevel, b: RiskLevel): number {
  return RISK_LEVELS.indexOf(a) - RISK_LEVELS.indexOf(b)
}

export function maxRisk(levels: readonly RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>(
    (acc, level) => (compareRisk(level, acc) > 0 ? level : acc),
    'low',
  )
}
