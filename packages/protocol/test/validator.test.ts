import { describe, expect, it } from 'vitest'
import {
  DSP_API_VERSION,
  createSchemaValidator,
  desiredStateSchema,
  policySchema,
} from '@dsp/protocol'

const specSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['users'],
  properties: {
    users: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['email', 'role'],
        properties: {
          email: { type: 'string' },
          role: { enum: ['admin', 'viewer'] },
        },
      },
    },
  },
}

describe('createSchemaValidator', () => {
  const validator = createSchemaValidator(specSchema, { basePath: 'spec' })

  it('accepts a valid value', () => {
    const result = validator.validate({ users: [{ email: 'a@b.c', role: 'admin' }] })
    expect(result).toEqual({ valid: true, errors: [], warnings: [] })
  })

  it('names the missing property in the path, not just the parent', () => {
    const result = validator.validate({ users: [{ email: 'a@b.c' }] })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual({
      code: 'SCHEMA_VALIDATION_FAILED',
      path: 'spec.users[0].role',
      message: 'Missing required property "role"',
    })
  })

  it('reports unknown properties by name', () => {
    const result = validator.validate({ users: [{ email: 'a@b.c', role: 'admin', extra: 1 }] })
    expect(result.errors[0]?.path).toBe('spec.users[0]')
    expect(result.errors[0]?.message).toContain('Unknown property "extra"')
  })

  it('lists the allowed values for an enum violation', () => {
    const result = validator.validate({ users: [{ email: 'a@b.c', role: 'root' }] })
    const enumError = result.errors.find((issue) => issue.message.includes('one of'))
    expect(enumError?.path).toBe('spec.users[0].role')
    expect(enumError?.message).toContain('admin')
  })

  it('reports every violation rather than stopping at the first', () => {
    const result = validator.validate({ users: [{}, {}] })
    expect(result.errors.length).toBeGreaterThanOrEqual(4)
  })

  it('prefixes paths with the base path only when one is configured', () => {
    const bare = createSchemaValidator(specSchema)
    expect(bare.validate({}).errors[0]?.path).toBe('users')
  })
})

describe('published desired-state schema', () => {
  const validator = createSchemaValidator(desiredStateSchema)

  const valid = {
    apiVersion: DSP_API_VERSION,
    kind: 'MockWorkspace',
    metadata: { name: 'dsp-demo' },
    spec: {},
  }

  it('accepts a minimal document', () => {
    expect(validator.validate(valid).valid).toBe(true)
  })

  it('pins the apiVersion', () => {
    expect(validator.validate({ ...valid, apiVersion: 'dsp.dev/v1' }).valid).toBe(false)
  })

  it('requires apiVersion, kind, metadata.name and spec', () => {
    for (const drop of ['apiVersion', 'kind', 'metadata', 'spec'] as const) {
      const partial: Record<string, unknown> = { ...valid }
      delete partial[drop]
      expect(validator.validate(partial).valid, drop).toBe(false)
    }
    expect(validator.validate({ ...valid, metadata: {} }).valid).toBe(false)
  })

  it('enforces the resource-name pattern', () => {
    expect(validator.validate({ ...valid, metadata: { name: 'Not Valid' } }).valid).toBe(false)
    expect(validator.validate({ ...valid, metadata: { name: 'ok-name-1' } }).valid).toBe(true)
  })

  it('rejects unknown top-level and metadata properties', () => {
    expect(validator.validate({ ...valid, extra: 1 }).valid).toBe(false)
    expect(validator.validate({ ...valid, metadata: { name: 'dsp-demo', extra: 1 } }).valid).toBe(
      false,
    )
  })

  it('accepts labels, annotations, namespace and requestId', () => {
    const result = validator.validate({
      ...valid,
      metadata: {
        name: 'dsp-demo',
        namespace: 'team-a',
        labels: { team: 'platform' },
        annotations: { note: 'x' },
        requestId: 'req_1',
      },
    })
    expect(result.valid).toBe(true)
  })
})

describe('published policy schema', () => {
  const validator = createSchemaValidator(policySchema)

  const valid = {
    apiVersion: DSP_API_VERSION,
    kind: 'Policy',
    metadata: { name: 'baseline' },
    spec: { rules: [{ id: 'block-delete', when: { action: 'delete' }, effect: 'deny' }] },
  }

  it('accepts a valid policy', () => {
    expect(validator.validate(valid).valid).toBe(true)
  })

  it('requires at least one rule', () => {
    expect(validator.validate({ ...valid, spec: { rules: [] } }).valid).toBe(false)
  })

  it('rejects an unknown effect', () => {
    const invalid = {
      ...valid,
      spec: { rules: [{ id: 'r', effect: 'destroy-everything' }] },
    }
    expect(validator.validate(invalid).valid).toBe(false)
  })

  it('rejects an unknown condition key so typos cannot silently disable a rule', () => {
    const invalid = {
      ...valid,
      spec: { rules: [{ id: 'r', when: { actions: 'delete' }, effect: 'deny' }] },
    }
    expect(validator.validate(invalid).valid).toBe(false)
  })
})
