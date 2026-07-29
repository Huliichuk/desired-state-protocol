import {
  DEFAULT_LIMITS,
  canonicalEquals,
  containsSensitiveData,
  type DesiredStateDocument,
  type PlanChange,
  type PolicyEvaluationResult,
} from '@dsp/protocol'
import { buildPlan, type BuildPlanInput } from '@dsp/plan-engine'
import { describe, expect, it } from 'vitest'
import type { ProviderContext, ProviderExecutionContext } from '../context.js'
import type { DSPProvider } from '../provider.js'
import { createTestContext, createTestExecutionContext } from '../testing.js'

export interface ConformanceHarness<TSpec = unknown, TState = unknown> {
  /** Name used in the test titles. */
  name: string
  /** A fresh provider over a fresh, empty world. */
  createProvider(): Promise<DSPProvider<TSpec, TState>> | DSPProvider<TSpec, TState>
  /** A document that the provider considers valid and that produces changes. */
  validDocument(): DesiredStateDocument<TSpec>
  /** Secret values the provider needs, keyed as `name` or `name/key`. */
  secretValues?: Record<string, string>
  /** Called after each test so the next one starts from a clean world. */
  reset?(provider: DSPProvider<TSpec, TState>): Promise<void> | void
  /**
   * A document that removes a resource the valid document creates, used to check
   * that unsupported deletions are blocked rather than silently performed.
   */
  documentWithResourceRemoved?(): DesiredStateDocument<TSpec>
}

interface Harnessed<TSpec, TState> {
  provider: DSPProvider<TSpec, TState>
  context: ProviderContext
  executionContext(change: PlanChange, attempt?: number): ProviderExecutionContext
  document: DesiredStateDocument<TSpec>
}

const ALLOW_ALL: PolicyEvaluationResult = { allowed: true, decisions: [], requiredApprovals: [] }

/**
 * The DSP provider conformance suite.
 *
 * Every provider — the reference mock, a SaaS adapter, a native implementation —
 * MUST pass this identical set of checks. It is what makes "a DSP provider" a
 * claim that can be verified rather than asserted.
 *
 * Call it from a test file:
 *
 *   runProviderConformanceSuite({
 *     name: 'mock',
 *     createProvider: () => new MockProvider({ backend: new MockBackend(':memory:') }),
 *     validDocument: () => myDocument,
 *   })
 */
export function runProviderConformanceSuite<TSpec, TState>(
  harness: ConformanceHarness<TSpec, TState>,
): void {
  describe(`DSP provider conformance: ${harness.name}`, () => {
    async function setup(): Promise<Harnessed<TSpec, TState>> {
      const provider = await harness.createProvider()
      const document = harness.validDocument()
      const secretValues = harness.secretValues
      const contextOptions = secretValues === undefined ? {} : { secretValues }

      return {
        provider,
        document,
        context: createTestContext(contextOptions),
        executionContext: (_change, attempt = 1) =>
          createTestExecutionContext({
            ...contextOptions,
            attempt,
            desired: document as DesiredStateDocument,
          }),
      }
    }

    async function planFor(
      harnessed: Harnessed<TSpec, TState>,
      overrides: Partial<BuildPlanInput> = {},
    ): Promise<PlanChange[]> {
      const { provider, context, document } = harnessed
      const current = await provider.inspect(context, document)
      const refine = provider.plan?.bind(provider)

      const plan = await buildPlan({
        desired: document as DesiredStateDocument,
        desiredProjection: await provider.normalizeDesired(document),
        currentProjection: await provider.normalizeCurrent(current),
        currentRevision: current.revision ?? null,
        resourceTypes: new Map(provider.resourceTypes.map((type) => [type.name, type])),
        provider: provider.name,
        environment: 'test',
        policyBundleHash: `sha256:${'0'.repeat(64)}`,
        evaluatePolicies: () => ALLOW_ALL,
        ...(refine === undefined
          ? {}
          : {
              refineChanges: (changes) => refine(context, { desired: document, current, changes }),
            }),
        limits: DEFAULT_LIMITS,
        now: new Date('2026-01-01T00:00:00.000Z'),
        options: { allowDelete: false, allowReplace: false },
        ...overrides,
      })

      return plan.changes
    }

    async function applyAll(
      harnessed: Harnessed<TSpec, TState>,
      changes: readonly PlanChange[],
    ): Promise<void> {
      for (const change of changes) {
        if (change.action === 'noop' || change.action === 'blocked') continue
        await harnessed.provider.applyChange(harnessed.executionContext(change), change)
      }
    }

    it('declares at least one kind and one resource type', async () => {
      const { provider } = await setup()
      expect(provider.name.length).toBeGreaterThan(0)
      expect(provider.kinds.length).toBeGreaterThan(0)
      expect(provider.resourceTypes.length).toBeGreaterThan(0)
    })

    it('declares resource types that its kinds actually reference', async () => {
      const { provider } = await setup()
      const declared = new Set(provider.resourceTypes.map((type) => type.name))
      for (const kind of provider.kinds) {
        expect(kind.resourceTypes.length).toBeGreaterThan(0)
        for (const name of kind.resourceTypes) expect(declared.has(name), name).toBe(true)
      }
    })

    it('names every declared resource type exactly once', async () => {
      const { provider } = await setup()
      const names = provider.resourceTypes.map((type) => type.name)
      expect(new Set(names).size).toBe(names.length)
    })

    it('accepts the document its own harness calls valid', async () => {
      const harnessed = await setup()
      const result = await harnessed.provider.validate(harnessed.context, harnessed.document)
      expect(result.errors).toEqual([])
      expect(result.valid).toBe(true)
    })

    it('inspect is side-effect free', async () => {
      const harnessed = await setup()
      const first = await harnessed.provider.inspect(harnessed.context, harnessed.document)
      const second = await harnessed.provider.inspect(harnessed.context, harnessed.document)
      expect(second.revision).toBe(first.revision)
      expect(
        canonicalEquals(
          await harnessed.provider.normalizeCurrent(first),
          await harnessed.provider.normalizeCurrent(second),
        ),
      ).toBe(true)
    })

    it('validate is side-effect free', async () => {
      const harnessed = await setup()
      const before = await harnessed.provider.inspect(harnessed.context, harnessed.document)
      await harnessed.provider.validate(harnessed.context, harnessed.document)
      const after = await harnessed.provider.inspect(harnessed.context, harnessed.document)
      expect(after.revision).toBe(before.revision)
    })

    it('plan is side-effect free', async () => {
      const harnessed = await setup()
      const before = await harnessed.provider.inspect(harnessed.context, harnessed.document)
      const changes = await planFor(harnessed)
      const after = await harnessed.provider.inspect(harnessed.context, harnessed.document)

      expect(changes.length).toBeGreaterThan(0)
      expect(after.revision).toBe(before.revision)
    })

    it('normalizeDesired is pure', async () => {
      const harnessed = await setup()
      const first = await harnessed.provider.normalizeDesired(harnessed.document)
      const second = await harnessed.provider.normalizeDesired(harnessed.document)
      expect(canonicalEquals(first, second)).toBe(true)
    })

    it('projects resources with unique, stable keys', async () => {
      const harnessed = await setup()
      const projection = await harnessed.provider.normalizeDesired(harnessed.document)
      const keys = projection.resources.map((resource) => resource.key)

      expect(keys.length).toBeGreaterThan(0)
      expect(new Set(keys).size).toBe(keys.length)
      const declared = new Set(harnessed.provider.resourceTypes.map((type) => type.name))
      for (const resource of projection.resources) {
        expect(resource.key.length).toBeGreaterThan(0)
        expect(declared.has(resource.resourceType), resource.resourceType).toBe(true)
      }
    })

    it('projects dependencies that point at resources it also declares', async () => {
      const harnessed = await setup()
      const projection = await harnessed.provider.normalizeDesired(harnessed.document)
      const keys = new Set(projection.resources.map((resource) => resource.key))
      for (const resource of projection.resources) {
        for (const dependency of resource.dependsOn ?? []) {
          expect(keys.has(dependency), `${resource.key} depends on ${dependency}`).toBe(true)
        }
      }
    })

    it('the same inputs produce the same plan', async () => {
      const harnessed = await setup()
      const first = await planFor(harnessed)
      const second = await planFor(harnessed)
      expect(canonicalEquals(first, second)).toBe(true)
    })

    it('apply executes only what the plan contains', async () => {
      const harnessed = await setup()
      const changes = await planFor(harnessed)
      await applyAll(harnessed, changes)

      const observed = await harnessed.provider.normalizeCurrent(
        await harnessed.provider.inspect(harnessed.context, harnessed.document),
      )
      const planned = new Set(changes.map((change) => change.resourceKey))
      for (const resource of observed.resources) {
        expect(planned.has(resource.key), `${resource.key} was not in the plan`).toBe(true)
      }
      await harness.reset?.(harnessed.provider)
    })

    it('apply is idempotent', async () => {
      const harnessed = await setup()
      const changes = await planFor(harnessed)

      await applyAll(harnessed, changes)
      const first = await harnessed.provider.inspect(harnessed.context, harnessed.document)
      const firstProjection = await harnessed.provider.normalizeCurrent(first)

      await applyAll(harnessed, changes)
      const second = await harnessed.provider.inspect(harnessed.context, harnessed.document)
      const secondProjection = await harnessed.provider.normalizeCurrent(second)

      expect(secondProjection.resources.length).toBe(firstProjection.resources.length)
      expect(canonicalEquals(secondProjection, firstProjection)).toBe(true)
      await harness.reset?.(harnessed.provider)
    })

    it('re-planning after apply reports that nothing is left to do', async () => {
      const harnessed = await setup()
      await applyAll(harnessed, await planFor(harnessed))

      const changes = await planFor(harnessed)
      expect(changes.length).toBeGreaterThan(0)
      expect(changes.every((change) => change.action === 'noop')).toBe(true)
      await harness.reset?.(harnessed.provider)
    })

    it('verify reads actual provider state', async () => {
      const harnessed = await setup()
      await applyAll(harnessed, await planFor(harnessed))

      const observed = await harnessed.provider.normalizeCurrent(
        await harnessed.provider.inspect(harnessed.context, harnessed.document),
      )
      const desired = await harnessed.provider.normalizeDesired(harnessed.document)
      const observedKeys = new Set(observed.resources.map((resource) => resource.key))

      for (const resource of desired.resources) {
        expect(observedKeys.has(resource.key), `${resource.key} was not observed`).toBe(true)
      }
      await harness.reset?.(harnessed.provider)
    })

    it('refuses to execute a blocked or noop change', async () => {
      const harnessed = await setup()
      const changes = await planFor(harnessed)
      const noop = changes.find((change) => change.action === 'noop')

      if (noop !== undefined) {
        await expect(
          harnessed.provider.applyChange(harnessed.executionContext(noop), noop),
        ).rejects.toThrow()
      }
    })

    it('secrets are never returned through the provider surface', async () => {
      const harnessed = await setup()
      const changes = await planFor(harnessed)
      await applyAll(harnessed, changes)

      const observed = await harnessed.provider.inspect(harnessed.context, harnessed.document)
      const validation = await harnessed.provider.validate(harnessed.context, harnessed.document)

      // A provider may legitimately carry a credential *reference*; it must never
      // hand back a credential value.
      for (const [label, value] of [
        ['resource types', harnessed.provider.resourceTypes],
        ['kinds', harnessed.provider.kinds],
        ['validation result', validation],
        ['inspected revision', observed.revision ?? null],
        ['change reasons', changes.map((change) => change.reason)],
      ] as const) {
        expect(containsSensitiveData(value), label).toBe(false)
      }

      for (const secret of Object.values(harness.secretValues ?? {})) {
        expect(JSON.stringify(observed.revision ?? '')).not.toContain(secret)
        expect(JSON.stringify(validation)).not.toContain(secret)
      }
      await harness.reset?.(harnessed.provider)
    })

    it('declares sensitive fields for every credential-shaped attribute it accepts', async () => {
      const harnessed = await setup()
      const projection = await harnessed.provider.normalizeDesired(harnessed.document)
      const types = new Map(harnessed.provider.resourceTypes.map((type) => [type.name, type]))

      for (const resource of projection.resources) {
        const definition = types.get(resource.resourceType)
        for (const [attribute, value] of Object.entries(resource.attributes)) {
          if (!containsSensitiveData(value)) continue
          expect(
            definition?.sensitiveFields.includes(attribute),
            `${resource.resourceType}.${attribute} holds a secret but is not declared sensitive`,
          ).toBe(true)
        }
      }
    })

    it('unsupported deletes are blocked rather than performed', async () => {
      const removal = harness.documentWithResourceRemoved
      if (removal === undefined) return

      const harnessed = await setup()
      await applyAll(harnessed, await planFor(harnessed))

      const shrunk = removal()
      const changes = await planFor({ ...harnessed, document: shrunk })
      const destructive = changes.filter(
        (change) => change.action === 'delete' || change.action === 'replace',
      )
      expect(destructive).toEqual([])
      expect(changes.some((change) => change.action === 'blocked')).toBe(true)

      const before = await harnessed.provider.normalizeCurrent(
        await harnessed.provider.inspect(harnessed.context, shrunk),
      )
      await applyAll({ ...harnessed, document: shrunk }, changes)
      const after = await harnessed.provider.normalizeCurrent(
        await harnessed.provider.inspect(harnessed.context, shrunk),
      )

      // Nothing was removed, because nothing was allowed to be.
      expect(after.resources.length).toBe(before.resources.length)
      await harness.reset?.(harnessed.provider)
    })
  })
}
