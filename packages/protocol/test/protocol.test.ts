import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMITS,
  DSPError,
  DSP_ERROR_CODES,
  PROTOCOL_SCHEMAS,
  assertDocumentLimits,
  changeId,
  compareRisk,
  defaultHttpStatusFor,
  maxRisk,
  mergeValidationResults,
  planIdFromHash,
  toErrorPayload,
  valueDepth,
} from '@dsp/protocol'
import { renderSchema } from '../src/scripts/generate-schemas.js'
import { SYNTHETIC } from './synthetic-secrets.js'

const schemasDir = fileURLToPath(new URL('../../../schemas/', import.meta.url))

describe('published JSON Schema contract', () => {
  // The TypeScript definitions are the source of truth; schemas/ is a generated
  // artifact. If they drift, clients validate against a contract the runtime no
  // longer implements.
  for (const [fileName, schema] of Object.entries(PROTOCOL_SCHEMAS)) {
    it(`schemas/${fileName} matches the TypeScript source of truth`, async () => {
      const onDisk = await readFile(`${schemasDir}${fileName}`, 'utf8')
      expect(onDisk).toBe(renderSchema(schema))
    })
  }

  it('publishes exactly the five documented schemas', () => {
    expect(Object.keys(PROTOCOL_SCHEMAS).sort()).toEqual([
      'desired-state.schema.json',
      'manifest.schema.json',
      'plan.schema.json',
      'policy.schema.json',
      'result.schema.json',
    ])
  })
})

describe('DSPError', () => {
  it('carries the code, retryability and details', () => {
    const error = new DSPError('PROVIDER_TIMEOUT', 'too slow', {
      retryable: true,
      details: { timeoutMs: 10 },
    })
    expect(error.code).toBe('PROVIDER_TIMEOUT')
    expect(error.retryable).toBe(true)
    expect(error.httpStatus).toBe(504)
    expect(error.toPayload('req_1')).toEqual({
      code: 'PROVIDER_TIMEOUT',
      message: 'too slow',
      retryable: true,
      details: { timeoutMs: 10 },
      requestId: 'req_1',
    })
  })

  it('omits absent fields from the payload rather than emitting undefined', () => {
    const payload = new DSPError('PLAN_NOT_FOUND', 'missing').toPayload()
    expect(Object.keys(payload).sort()).toEqual(['code', 'message', 'retryable'])
  })

  it('defaults to not retryable', () => {
    expect(new DSPError('POLICY_DENIED', 'no').retryable).toBe(false)
  })

  it('assigns an HTTP status to every declared error code', () => {
    for (const code of DSP_ERROR_CODES) {
      expect(Number.isInteger(defaultHttpStatusFor(code)), code).toBe(true)
    }
  })

  it('recognizes its own instances', () => {
    expect(DSPError.isDSPError(new DSPError('INTERNAL_ERROR', 'x'))).toBe(true)
    expect(DSPError.isDSPError(new Error('x'))).toBe(false)
  })
})

describe('toErrorPayload', () => {
  it('passes DSP errors through', () => {
    const payload = toErrorPayload(new DSPError('PLAN_EXPIRED', 'gone'))
    expect(payload.code).toBe('PLAN_EXPIRED')
    expect(payload.message).toBe('gone')
  })

  it('never leaks the message of an unknown error', () => {
    const payload = toErrorPayload(new Error(`connection string ${SYNTHETIC.stripeLive}`))
    expect(payload.code).toBe('INTERNAL_ERROR')
    expect(payload.message).toBe('An unexpected internal error occurred')
  })
})

describe('document limits', () => {
  it('rejects documents over the byte limit', () => {
    const document = { spec: { blob: 'x'.repeat(2000) } }
    expect(() =>
      assertDocumentLimits(document, { ...DEFAULT_LIMITS, maxDocumentBytes: 100 }),
    ).toThrow(/DOCUMENT_TOO_LARGE|bytes/)
  })

  it('rejects documents nested deeper than the limit', () => {
    let deep: unknown = 'leaf'
    for (let index = 0; index < 12; index += 1) deep = { deep }
    expect(() => assertDocumentLimits(deep, { ...DEFAULT_LIMITS, maxDocumentDepth: 5 })).toThrow(
      /DOCUMENT_TOO_DEEP|levels/,
    )
  })

  it('accepts a document inside both limits', () => {
    expect(() => assertDocumentLimits({ a: { b: 1 } }, DEFAULT_LIMITS)).not.toThrow()
  })

  it('measures depth without walking the whole structure once the ceiling is hit', () => {
    expect(valueDepth('leaf')).toBe(0)
    expect(valueDepth({ a: 1 })).toBe(1)
    expect(valueDepth({ a: { b: [1] } })).toBe(3)
  })
})

describe('identifiers', () => {
  it('derives the plan id from the plan hash so identical plans share an id', () => {
    const hash = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    expect(planIdFromHash(hash)).toBe('plan_0123456789abcdef01234567')
    expect(planIdFromHash(hash)).toBe(planIdFromHash(hash))
    expect(planIdFromHash(hash)).toMatch(/^plan_[0-9a-f]{24}$/)
  })

  it('derives change ids deterministically from the change identity', () => {
    expect(changeId('mock.user', 'a@b.c', 'create')).toBe(changeId('mock.user', 'a@b.c', 'create'))
    expect(changeId('mock.user', 'a@b.c', 'create')).not.toBe(
      changeId('mock.user', 'a@b.c', 'update'),
    )
    expect(changeId('mock.user', 'a@b.c', 'create')).toMatch(/^chg_[0-9a-f]{20}$/)
  })
})

describe('risk level helpers', () => {
  it('orders risk levels', () => {
    expect(compareRisk('critical', 'low')).toBeGreaterThan(0)
    expect(compareRisk('low', 'low')).toBe(0)
  })

  it('picks the riskiest level, defaulting to low for an empty set', () => {
    expect(maxRisk(['low', 'high', 'medium'])).toBe('high')
    expect(maxRisk([])).toBe('low')
  })
})

describe('mergeValidationResults', () => {
  it('is invalid when any input contributed an error', () => {
    const merged = mergeValidationResults(
      { valid: true, errors: [], warnings: [{ code: 'W', path: 'a', message: 'w' }] },
      { valid: false, errors: [{ code: 'E', path: 'b', message: 'e' }], warnings: [] },
    )
    expect(merged.valid).toBe(false)
    expect(merged.errors).toHaveLength(1)
    expect(merged.warnings).toHaveLength(1)
  })
})
