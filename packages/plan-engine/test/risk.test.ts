import { describe, expect, it } from 'vitest'
import type { PlanChange, RiskLevel } from '@dsp/protocol'
import {
  RISK_WEIGHTS,
  blastRadiusWeight,
  environmentWeight,
  riskLevelFromScore,
  scoreChange,
  scorePlan,
  withChangeRisk,
} from '@dsp/plan-engine'
import { DB_TYPE, SUB_TYPE, TABLE_TYPE, resourceTypes } from './fixtures.js'

function change(overrides: Partial<PlanChange> = {}): PlanChange {
  return {
    id: 'chg_1',
    resourceType: DB_TYPE,
    resourceKey: 'db/main',
    action: 'create',
    fields: [],
    reason: 'because',
    reversible: false,
    destructive: false,
    dependencies: [],
    estimatedRisk: 'low',
    ...overrides,
  }
}

const context = (environment = 'test') => ({ environment, resourceTypes })

describe('scoreChange', () => {
  it('scores nothing for changes that never reach the provider', () => {
    expect(scoreChange(change({ action: 'noop' }), context())).toBe(0)
    expect(scoreChange(change({ action: 'blocked' }), context())).toBe(0)
  })

  it('charges the most for a deletion', () => {
    const score = scoreChange(change({ action: 'delete', reversible: false }), context())
    expect(score).toBe(RISK_WEIGHTS.destructiveDelete + RISK_WEIGHTS.irreversible)
  })

  it('charges less for a replace than for a delete', () => {
    const replace = scoreChange(change({ action: 'replace' }), context())
    const remove = scoreChange(change({ action: 'delete' }), context())
    expect(replace).toBeLessThan(remove)
  })

  it('charges for irreversibility only when the change cannot be undone', () => {
    const reversible = scoreChange(change({ action: 'update', reversible: true }), context())
    const irreversible = scoreChange(change({ action: 'update', reversible: false }), context())
    expect(irreversible - reversible).toBe(RISK_WEIGHTS.irreversible)
  })

  it('charges more in production than in staging, and nothing elsewhere', () => {
    expect(environmentWeight('production')).toBe(RISK_WEIGHTS.environmentProduction)
    expect(environmentWeight('PROD')).toBe(RISK_WEIGHTS.environmentProduction)
    expect(environmentWeight('live')).toBe(RISK_WEIGHTS.environmentProduction)
    expect(environmentWeight('staging')).toBe(RISK_WEIGHTS.environmentStaging)
    expect(environmentWeight('local')).toBe(0)
    expect(environmentWeight(' Test ')).toBe(0)
  })

  it('charges for touching a field the resource type declared sensitive', () => {
    const plain = scoreChange(
      change({ resourceType: TABLE_TYPE, action: 'update', reversible: true }),
      context(),
    )
    const sensitive = scoreChange(
      change({
        resourceType: TABLE_TYPE,
        action: 'update',
        reversible: true,
        fields: [{ path: 'apiToken', before: 'a', after: 'b', immutable: false }],
      }),
      context(),
    )
    expect(sensitive - plain).toBe(RISK_WEIGHTS.sensitiveField)
  })

  it('charges for financial and externally visible resource types', () => {
    const financial = scoreChange(
      change({ resourceType: SUB_TYPE, action: 'update', reversible: true }),
      context(),
    )
    expect(financial).toBe(RISK_WEIGHTS.financial + RISK_WEIGHTS.externallyVisible)
  })

  it('treats an unknown resource type as carrying no extra risk factors', () => {
    expect(scoreChange(change({ resourceType: 'unknown.type', reversible: true }), context())).toBe(
      0,
    )
  })

  it('never exceeds 100', () => {
    const worst = scoreChange(
      change({
        resourceType: SUB_TYPE,
        action: 'delete',
        reversible: false,
        fields: [{ path: 'currency', before: 'eur', after: 'usd', immutable: true }],
      }),
      context('production'),
    )
    expect(worst).toBeLessThanOrEqual(100)
  })
})

describe('riskLevelFromScore', () => {
  const boundaries: Array<[number, RiskLevel]> = [
    [0, 'low'],
    [19, 'low'],
    [20, 'medium'],
    [49, 'medium'],
    [50, 'high'],
    [79, 'high'],
    [80, 'critical'],
    [100, 'critical'],
  ]

  for (const [score, level] of boundaries) {
    it(`maps ${score} to ${level}`, () => {
      expect(riskLevelFromScore(score)).toBe(level)
    })
  }
})

describe('blastRadiusWeight', () => {
  it('grows in buckets with the number of effective changes', () => {
    expect(blastRadiusWeight(0)).toBe(0)
    expect(blastRadiusWeight(1)).toBe(0)
    expect(blastRadiusWeight(5)).toBe(6)
    expect(blastRadiusWeight(6)).toBe(12)
    expect(blastRadiusWeight(20)).toBe(12)
    expect(blastRadiusWeight(21)).toBe(20)
  })
})

describe('scorePlan', () => {
  it('combines the riskiest change with the blast radius of the whole plan', () => {
    const changes = [
      change({ id: 'a', action: 'create', reversible: false }),
      change({ id: 'b', resourceType: SUB_TYPE, action: 'create', reversible: false }),
    ]
    const single = scoreChange(changes[1] as PlanChange, context())
    expect(scorePlan(changes, context()).score).toBe(single + blastRadiusWeight(2))
  })

  it('ignores noop and blocked changes when measuring blast radius', () => {
    const risky = change({ id: 'a', action: 'create', reversible: false })
    const withNoops = [
      risky,
      change({ id: 'b', action: 'noop' }),
      change({ id: 'c', action: 'blocked' }),
    ]
    expect(scorePlan(withNoops, context()).score).toBe(scorePlan([risky], context()).score)
  })

  it('scores an empty plan as low', () => {
    expect(scorePlan([], context())).toEqual({ score: 0, level: 'low' })
  })

  it('is deterministic', () => {
    const changes = [change({ action: 'delete' })]
    expect(scorePlan(changes, context('production'))).toEqual(
      scorePlan(changes, context('production')),
    )
  })
})

describe('withChangeRisk', () => {
  it('annotates each change with its own level and leaves the rest untouched', () => {
    const [noop, remove] = withChangeRisk(
      [change({ id: 'a', action: 'noop' }), change({ id: 'b', action: 'delete' })],
      context('production'),
    )
    expect(noop?.estimatedRisk).toBe('low')
    expect(remove?.estimatedRisk).toBe('high')
    expect(remove?.reason).toBe('because')
  })
})
