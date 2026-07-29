import { describe, expect, it } from 'vitest'
import { REDACTED, containsSensitiveData, redactSensitiveData, redactString } from '@dsp/protocol'
import { SYNTHETIC } from './synthetic-secrets.js'

describe('redactSensitiveData — key based', () => {
  it('removes values under sensitive property names', () => {
    const out = redactSensitiveData({
      authorization: 'Bearer abc',
      cookie: 'session=1',
      apiToken: 'plaintext-token',
      password: 'hunter2',
      clientSecret: 'shh',
      privateKey: 'pem',
      accessKeyId: 'AKIA',
      keep: 'visible',
    }) as Record<string, unknown>

    expect(out['authorization']).toBe(REDACTED)
    expect(out['cookie']).toBe(REDACTED)
    expect(out['apiToken']).toBe(REDACTED)
    expect(out['password']).toBe(REDACTED)
    expect(out['clientSecret']).toBe(REDACTED)
    expect(out['privateKey']).toBe(REDACTED)
    expect(out['accessKeyId']).toBe(REDACTED)
    expect(out['keep']).toBe('visible')
  })

  it('matches sensitive keys case-insensitively and at any depth', () => {
    const out = redactSensitiveData({ a: { b: { API_KEY: 'x' } } }) as {
      a: { b: { API_KEY: string } }
    }
    expect(out.a.b.API_KEY).toBe(REDACTED)
  })

  it('leaves a plain object structurally unchanged', () => {
    const input = { name: 'main', tables: [{ name: 'users', columns: ['id'] }], count: 3 }
    expect(redactSensitiveData(input)).toEqual(input)
  })
})

describe('redactSensitiveData — value based', () => {
  const cases: Array<[string, string]> = [
    ['stripe secret key', SYNTHETIC.stripeLive],
    ['stripe test key', SYNTHETIC.stripeTest],
    ['stripe restricted key', SYNTHETIC.stripeRestricted],
    ['stripe webhook secret', SYNTHETIC.stripeWebhook],
    ['github token', SYNTHETIC.githubToken],
    ['slack token', SYNTHETIC.slackToken],
    ['aws access key id', SYNTHETIC.awsAccessKeyId],
    ['jwt', SYNTHETIC.jwt],
  ]

  for (const [name, secret] of cases) {
    it(`redacts a ${name} even under an innocent key`, () => {
      const out = redactSensitiveData({ note: `value is ${secret}` }) as { note: string }
      expect(out.note).not.toContain(secret)
      expect(out.note).toContain(REDACTED)
    })
  }

  it('redacts a PEM private key block', () => {
    const pem = SYNTHETIC.pemPrivateKey
    expect(redactString(pem)).toBe(REDACTED)
  })

  it('redacts a bearer credential embedded in free text', () => {
    const out = redactString('sent Bearer aaaaaaaaaaaaaaaaaaaaaaaa to the api')
    expect(out).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa')
  })
})

describe('redactSensitiveData — options', () => {
  it('redacts declared attribute paths, including array indices', () => {
    const out = redactSensitiveData(
      { users: [{ email: 'a@b.c', apiToken: 'tok' }, { email: 'd@e.f' }] },
      { paths: ['users[].apiToken'] },
    ) as { users: Array<Record<string, unknown>> }

    expect(out.users[0]?.['apiToken']).toBe(REDACTED)
    expect(out.users[0]?.['email']).toBe('a@b.c')
  })

  it('redacts explicit literal values wherever they appear', () => {
    const out = redactSensitiveData(
      { note: 'token is s3cr3t-value', nested: { also: 's3cr3t-value' } },
      { values: ['s3cr3t-value'] },
    ) as { note: string; nested: { also: string } }

    expect(out.note).not.toContain('s3cr3t-value')
    expect(out.nested.also).toBe(REDACTED)
  })

  it('ignores literal values too short to be meaningful', () => {
    const out = redactSensitiveData({ note: 'abc' }, { values: ['abc'] }) as { note: string }
    expect(out.note).toBe('abc')
  })

  it('honours a base path when matching declared paths', () => {
    const out = redactSensitiveData(
      { apiToken: 'tok' },
      {
        paths: ['spec.apiToken'],
        basePath: 'spec',
      },
    ) as Record<string, unknown>
    expect(out['apiToken']).toBe(REDACTED)
  })
})

describe('redactSensitiveData — robustness', () => {
  it('survives circular references', () => {
    const node: Record<string, unknown> = { name: 'a' }
    node['self'] = node
    expect(() => redactSensitiveData(node)).not.toThrow()
    expect((redactSensitiveData(node) as Record<string, unknown>)['self']).toBe('[CIRCULAR]')
  })

  it('reduces errors to name and message so stacks never leak', () => {
    const out = redactSensitiveData(new Error(`failed with ${SYNTHETIC.stripeLive}`)) as {
      name: string
      message: string
    }
    expect(out).not.toHaveProperty('stack')
    expect(out.message).not.toContain('sk_live')
  })

  it('normalizes dates and preserves primitives', () => {
    expect(redactSensitiveData(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      '2026-01-01T00:00:00.000Z',
    )
    expect(redactSensitiveData(42)).toBe(42)
    expect(redactSensitiveData(null)).toBeNull()
  })
})

describe('containsSensitiveData', () => {
  it('detects secret shapes anywhere in a structure', () => {
    expect(containsSensitiveData({ a: { b: SYNTHETIC.stripeLive } })).toBe(true)
    expect(containsSensitiveData({ a: 'ordinary text' })).toBe(false)
  })

  it('reports clean output after redaction', () => {
    const dirty = { note: SYNTHETIC.githubToken }
    expect(containsSensitiveData(dirty)).toBe(true)
    expect(containsSensitiveData(redactSensitiveData(dirty))).toBe(false)
  })
})
