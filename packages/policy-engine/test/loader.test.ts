import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DSPError, DSP_API_VERSION } from '@dsp/protocol'
import {
  BASELINE_SAFETY_POLICY,
  EMPTY_POLICY_BUNDLE,
  assertUniqueNames,
  defaultPolicyBundle,
  evaluatePolicies,
  loadPolicyBundleFromDirectory,
  parsePolicyDocument,
  parsePolicyText,
} from '@dsp/policy-engine'

const validYaml = `
apiVersion: ${DSP_API_VERSION}
kind: Policy
metadata:
  name: from-disk
spec:
  rules:
    - id: block-delete
      when:
        action: delete
      effect: deny
      message: Destructive operations are disabled
`

describe('parsePolicyText', () => {
  it('accepts a valid YAML policy', () => {
    const policy = parsePolicyText(validYaml, 'inline.yaml')
    expect(policy.metadata.name).toBe('from-disk')
    expect(policy.spec.rules[0]?.effect).toBe('deny')
  })

  it('accepts JSON, which is a subset of YAML', () => {
    const policy = parsePolicyText(
      JSON.stringify({
        apiVersion: DSP_API_VERSION,
        kind: 'Policy',
        metadata: { name: 'json' },
        spec: { rules: [{ id: 'r', effect: 'warn' }] },
      }),
    )
    expect(policy.metadata.name).toBe('json')
  })

  it('rejects text that is not YAML', () => {
    expect(() => parsePolicyText('{ unbalanced: [', 'broken.yaml')).toThrow(DSPError)
    expect(() => parsePolicyText('{ unbalanced: [', 'broken.yaml')).toThrow(/broken.yaml/)
  })

  it('rejects a policy with an unknown effect', () => {
    const invalid = validYaml.replace('effect: deny', 'effect: destroy')
    expect(() => parsePolicyText(invalid)).toThrow(/Invalid policy document/)
  })

  it('rejects a rule without an id', () => {
    expect(() =>
      parsePolicyDocument({
        apiVersion: DSP_API_VERSION,
        kind: 'Policy',
        metadata: { name: 'x' },
        spec: { rules: [{ effect: 'deny' }] },
      }),
    ).toThrow(DSPError)
  })

  it('rejects an unknown condition key so a typo cannot silently disable a rule', () => {
    expect(() =>
      parsePolicyDocument({
        apiVersion: DSP_API_VERSION,
        kind: 'Policy',
        metadata: { name: 'x' },
        spec: { rules: [{ id: 'r', when: { actions: 'delete' }, effect: 'deny' }] },
      }),
    ).toThrow(DSPError)
  })

  it('reports the source and the schema errors in the thrown details', () => {
    try {
      parsePolicyText(
        'apiVersion: wrong\nkind: Policy\nmetadata: {name: x}\nspec: {rules: []}',
        'f.yaml',
      )
      expect.unreachable('an invalid policy must be rejected')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('VALIDATION_FAILED')
      expect(error.details?.['source']).toBe('f.yaml')
      expect(Array.isArray(error.details?.['errors'])).toBe(true)
    }
  })
})

describe('loadPolicyBundleFromDirectory', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsp-policies-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('returns an empty bundle for a directory that does not exist', async () => {
    expect(await loadPolicyBundleFromDirectory(join(directory, 'absent'))).toEqual({ policies: [] })
  })

  it('loads yaml, yml and json policies and ignores everything else', async () => {
    await writeFile(join(directory, 'a.yaml'), validYaml)
    await writeFile(join(directory, 'b.yml'), validYaml.replace('from-disk', 'second'))
    await writeFile(
      join(directory, 'c.json'),
      JSON.stringify({
        apiVersion: DSP_API_VERSION,
        kind: 'Policy',
        metadata: { name: 'third' },
        spec: { rules: [{ id: 'r', effect: 'warn' }] },
      }),
    )
    await writeFile(join(directory, 'README.md'), '# not a policy')

    const bundle = await loadPolicyBundleFromDirectory(directory)
    expect(bundle.policies.map((policy) => policy.metadata.name).sort()).toEqual([
      'from-disk',
      'second',
      'third',
    ])
  })

  it('refuses two policies with the same name', async () => {
    await writeFile(join(directory, 'a.yaml'), validYaml)
    await writeFile(join(directory, 'b.yaml'), validYaml)
    await expect(loadPolicyBundleFromDirectory(directory)).rejects.toThrow(/Duplicate policy name/)
  })

  it('fails loudly on a malformed policy rather than skipping it', async () => {
    await writeFile(join(directory, 'a.yaml'), validYaml)
    await writeFile(join(directory, 'b.yaml'), 'kind: Policy')
    await expect(loadPolicyBundleFromDirectory(directory)).rejects.toThrow(DSPError)
  })

  it('loads the policy bundle shipped with the example', async () => {
    const bundle = await loadPolicyBundleFromDirectory('examples/mock-workspace/policies')
    expect(bundle.policies).toHaveLength(1)
    expect(bundle.policies[0]?.metadata.name).toBe('production-safety')
    expect(bundle.policies[0]?.spec.rules.length).toBeGreaterThan(3)
  })
})

describe('assertUniqueNames', () => {
  it('accepts distinct names and rejects a repeat', () => {
    const one = { ...BASELINE_SAFETY_POLICY }
    expect(() => assertUniqueNames([one])).not.toThrow()
    expect(() => assertUniqueNames([one, one])).toThrow(/Duplicate policy name/)
  })
})

describe('default bundle', () => {
  const bundle = defaultPolicyBundle()

  const evaluate = (action: 'delete' | 'replace' | 'create', risk: 'low' | 'high') =>
    evaluatePolicies(bundle, {
      changes: [
        {
          id: 'chg_1',
          resourceType: 'mock.database',
          resourceKey: 'db/main',
          action,
          fields: [],
          reason: 'r',
          reversible: false,
          destructive: action !== 'create',
          dependencies: [],
          estimatedRisk: risk,
        },
      ],
      risk: { score: risk === 'high' ? 60 : 5, level: risk },
      context: {
        environment: 'local',
        kind: 'MockWorkspace',
        namespace: 'default',
        resourceName: 'demo',
      },
    })

  it('blocks deletions out of the box', () => {
    expect(evaluate('delete', 'low').allowed).toBe(false)
  })

  it('blocks replacements out of the box', () => {
    expect(evaluate('replace', 'low').allowed).toBe(false)
  })

  it('requires approval for high risk changes', () => {
    const result = evaluate('create', 'high')
    expect(result.allowed).toBe(true)
    expect(result.requiredApprovals).toHaveLength(1)
  })

  it('allows an ordinary low risk create without approval', () => {
    const result = evaluate('create', 'low')
    expect(result.allowed).toBe(true)
    expect(result.requiredApprovals).toEqual([])
  })

  it('exposes an empty bundle for runtimes that opt out', () => {
    expect(EMPTY_POLICY_BUNDLE.policies).toEqual([])
  })
})
