import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DSPError,
  DSP_API_VERSION,
  containsSensitiveData,
  type DSPPlan,
  type OperationRecord,
  type ValidationResult,
  type VerificationResult,
} from '@dsp/protocol'
import { createRuntime, type RuntimeBundle } from '@dsp/core'
import { EMPTY_POLICY_BUNDLE } from '@dsp/policy-engine'
import { MockBackend, MockProvider } from '@dsp/provider-mock'
import { silentLogger } from '@dsp/provider-sdk'
import type { FastifyInstance } from 'fastify'
import { createServer } from '../../server/src/server.js'
import { DspClient } from '../src/client.js'
import { EXIT, exitCodeFor } from '../src/exit-codes.js'
import {
  renderAudit,
  renderManifest,
  renderOperation,
  renderPlan,
  renderValidation,
  renderVerification,
} from '../src/render.js'
import { setColorEnabled } from '../src/style.js'
import { buildProgram } from '../src/program.js'

const ESC = String.fromCharCode(27)

/**
 * Assembled at runtime so no credential-shaped literal sits in the repository: a
 * literal `sk_live_…` trips GitHub push protection and raises a false
 * leaked-key alert at the vendor, even when the value is invented.
 */
const synthetic = (...parts: string[]): string => parts.join('')

const CLI_CANARY = synthetic('sk', '_', 'test', '_', 'cliLeakCheck1234567890')
const STRIPE_LIVE = synthetic('sk', '_', 'live', '_', '51H8xAbCdEfGhIjKlMnOpQr')

const desiredState = {
  apiVersion: DSP_API_VERSION,
  kind: 'MockWorkspace',
  metadata: { name: 'demo' },
  spec: {
    databases: [{ name: 'main', engine: 'postgres', region: 'eu-central-1' }],
    users: [{ email: 'founder@example.com', role: 'admin', apiToken: CLI_CANARY }],
  },
}

describe('exit codes', () => {
  it('maps every documented failure onto its own code', () => {
    expect(exitCodeFor('VALIDATION_FAILED')).toBe(EXIT.invalidDocument)
    expect(exitCodeFor('SCHEMA_VALIDATION_FAILED')).toBe(EXIT.invalidDocument)
    expect(exitCodeFor('APPROVAL_REQUIRED')).toBe(EXIT.approvalRequired)
    expect(exitCodeFor('APPROVAL_INVALID')).toBe(EXIT.approvalRequired)
    expect(exitCodeFor('POLICY_DENIED')).toBe(EXIT.policyDenied)
    expect(exitCodeFor('DESTRUCTIVE_ACTION_BLOCKED')).toBe(EXIT.policyDenied)
    expect(exitCodeFor('STATE_DRIFT_DETECTED')).toBe(EXIT.stateDrift)
    expect(exitCodeFor('PLAN_EXPIRED')).toBe(EXIT.planExpired)
  })

  it('falls back to the generic failure code', () => {
    expect(exitCodeFor('PROVIDER_TIMEOUT')).toBe(EXIT.error)
    expect(exitCodeFor('SOMETHING_NEW')).toBe(EXIT.error)
  })

  it('keeps success distinct from every failure', () => {
    const failures = Object.entries(EXIT)
      .filter(([name]) => name !== 'ok')
      .map(([, code]) => code)
    expect(failures).not.toContain(EXIT.ok)
    expect(new Set(failures).size).toBe(failures.length)
  })
})

describe('rendering', () => {
  beforeEach(() => {
    setColorEnabled(false)
  })

  const plan: DSPPlan = {
    apiVersion: DSP_API_VERSION,
    kind: 'Plan',
    metadata: {
      id: `plan_${'a'.repeat(24)}`,
      createdAt: '2026-07-29T18:00:00.000Z',
      expiresAt: '2026-07-29T18:15:00.000Z',
      desiredStateHash: `sha256:${'1'.repeat(64)}`,
      currentStateHash: `sha256:${'2'.repeat(64)}`,
      policyBundleHash: `sha256:${'3'.repeat(64)}`,
      planHash: `sha256:${'a'.repeat(64)}`,
      kind: 'MockWorkspace',
      namespace: 'default',
      resourceName: 'demo',
      provider: 'mock',
      currentRevision: 'empty',
    },
    summary: {
      create: 1,
      update: 1,
      delete: 0,
      replace: 0,
      noop: 1,
      blocked: 1,
      risk: 'medium',
      riskScore: 36,
    },
    changes: [
      {
        id: 'chg_create',
        resourceType: 'mock.database',
        resourceKey: 'mock.database/main',
        action: 'create',
        fields: [],
        reason: 'does not exist yet',
        reversible: false,
        destructive: false,
        dependencies: [],
        estimatedRisk: 'low',
        after: { name: 'main' },
      },
      {
        id: 'chg_update',
        resourceType: 'mock.user',
        resourceKey: 'mock.user/founder@example.com',
        action: 'update',
        fields: [{ path: 'role', before: 'viewer', after: 'admin', immutable: false }],
        reason: 'field(s) changed: role',
        reversible: true,
        destructive: false,
        dependencies: [],
        estimatedRisk: 'medium',
      },
      {
        id: 'chg_noop',
        resourceType: 'mock.table',
        resourceKey: 'mock.table/main.users',
        action: 'noop',
        fields: [],
        reason: 'already matches',
        reversible: true,
        destructive: false,
        dependencies: [],
        estimatedRisk: 'low',
      },
      {
        id: 'chg_blocked',
        resourceType: 'mock.subscription',
        resourceKey: 'mock.subscription/founder@example.com',
        action: 'blocked',
        fields: [],
        reason: 'Deletions are disabled (intended action: delete)',
        reversible: false,
        destructive: true,
        dependencies: [],
        estimatedRisk: 'low',
        blockedBy: 'DESTRUCTIVE_ACTION_BLOCKED',
      },
    ],
    approvals: {
      required: true,
      requirements: [{ id: 'apr_1', reason: 'needs a human', minApprovals: 1, risk: 'medium' }],
    },
    policyEvaluation: {
      allowed: true,
      decisions: [
        {
          policyId: 'production-safety',
          ruleId: 'approve-user-changes',
          effect: 'requireApproval',
          changeIds: ['chg_update'],
          message: 'Membership changes require approval',
        },
      ],
      requiredApprovals: [
        { id: 'apr_1', reason: 'needs a human', minApprovals: 1, risk: 'medium' },
      ],
    },
    executable: true,
  }

  it('shows the plan identity, risk and every action', () => {
    const output = renderPlan(plan)

    expect(output).toContain('DSP PLAN')
    expect(output).toContain('MockWorkspace/demo')
    expect(output).toContain('MEDIUM')
    expect(output).toContain('score 36')
    expect(output).toContain('+ CREATE mock.database/main')
    expect(output).toContain('~ UPDATE mock.user/founder@example.com')
    expect(output).toContain('= NOOP mock.table/main.users')
    expect(output).toContain('BLOCKED mock.subscription/founder@example.com')
  })

  it('shows the field level diff', () => {
    expect(renderPlan(plan)).toContain('role: viewer')
    expect(renderPlan(plan)).toContain('admin')
  })

  it('shows the summary, the approval state and the hash a reviewer must check', () => {
    const output = renderPlan(plan)
    expect(output).toContain('Create:   1')
    expect(output).toContain('Blocked:  1')
    expect(output).toContain('Approval required: yes')
    expect(output).toContain(plan.metadata.id)
    expect(output).toContain(plan.metadata.planHash)
  })

  it('shows the policy decisions that shaped the plan', () => {
    const output = renderPlan(plan)
    expect(output).toContain('APPROVAL')
    expect(output).toContain('production-safety/approve-user-changes')
  })

  it('says plainly when there is nothing to do', () => {
    expect(renderPlan({ ...plan, changes: [] })).toContain('no changes')
  })

  it('marks an immutable field so the reader knows why a change is blocked', () => {
    const immutable: DSPPlan = {
      ...plan,
      changes: [
        {
          ...plan.changes[1]!,
          fields: [{ path: 'currency', before: 'eur', after: 'usd', immutable: true }],
        },
      ],
    }
    expect(renderPlan(immutable)).toContain('(immutable)')
  })

  it('emits no ANSI escapes when colour is disabled', () => {
    for (const output of [
      renderPlan(plan),
      renderValidation({
        valid: false,
        errors: [{ code: 'E', path: 'spec', message: 'bad' }],
        warnings: [],
      }),
      renderAudit([]),
    ]) {
      expect(output).not.toContain(ESC)
    }
  })

  it('never prints a secret carried in a plan', () => {
    const leaky: DSPPlan = {
      ...plan,
      changes: [
        {
          ...plan.changes[0]!,
          after: { name: 'main', apiToken: STRIPE_LIVE },
        },
      ],
    }
    const output = renderPlan(leaky)
    expect(output).not.toContain(STRIPE_LIVE)
  })

  it('lists validation errors with their code and path', () => {
    const result: ValidationResult = {
      valid: false,
      errors: [
        { code: 'IMMUTABLE_FIELD_CHANGED', path: 'spec.databases[0].engine', message: 'no' },
      ],
      warnings: [
        { code: 'INLINE_SECRET', path: 'spec.users[0].apiToken', message: 'prefer a ref' },
      ],
    }
    const output = renderValidation(result)
    expect(output).toContain('IMMUTABLE_FIELD_CHANGED')
    expect(output).toContain('spec.databases[0].engine')
    expect(output).toContain('INLINE_SECRET')
  })

  it('confirms a valid document', () => {
    expect(renderValidation({ valid: true, errors: [], warnings: [] })).toContain('is valid')
  })

  it('shows per-change status and the satisfaction percentage', () => {
    const operation: OperationRecord = {
      id: `op_${'b'.repeat(24)}`,
      tenant: 'local',
      planId: plan.metadata.id,
      planHash: plan.metadata.planHash,
      idempotencyKey: 'k',
      status: 'partially_completed',
      actor: { type: 'agent', id: 'demo' },
      createdAt: '2026-07-29T18:00:00.000Z',
      updatedAt: '2026-07-29T18:00:01.000Z',
      changes: [
        {
          changeId: 'chg_create',
          resourceType: 'mock.database',
          resourceKey: 'mock.database/main',
          action: 'create',
          status: 'succeeded',
          attempts: 1,
        },
        {
          changeId: 'chg_blocked',
          resourceType: 'mock.subscription',
          resourceKey: 'mock.subscription/founder@example.com',
          action: 'blocked',
          status: 'blocked',
          attempts: 0,
          error: { code: 'DESTRUCTIVE_ACTION_BLOCKED', message: 'disabled', retryable: false },
        },
      ],
      verification: {
        operationId: `op_${'b'.repeat(24)}`,
        status: 'partially_satisfied',
        satisfaction: 0.85,
        verifiedAt: '2026-07-29T18:00:02.000Z',
        matched: ['mock.database/main.name'],
        unmatched: [{ path: 'mock.subscription/x.plan', reason: 'missing' }],
      },
      cancellationRequested: false,
      error: null,
    }

    const output = renderOperation(operation)
    expect(output).toContain('DSP APPLY')
    expect(output).toContain('succeeded')
    expect(output).toContain('blocked')
    expect(output).toContain('partially_completed')
    expect(output).toContain('85%')
    expect(output).toContain('mock.subscription/x.plan')
  })

  it('renders a verification result on its own', () => {
    const verification: VerificationResult = {
      operationId: `op_${'b'.repeat(24)}`,
      status: 'satisfied',
      satisfaction: 1,
      verifiedAt: '2026-07-29T18:00:02.000Z',
      matched: ['a.b'],
      unmatched: [],
    }
    const output = renderVerification(verification)
    expect(output).toContain('satisfied')
    expect(output).toContain('100%')
  })

  it('renders the manifest with its feature flags', () => {
    const output = renderManifest({
      protocol: 'dsp',
      protocolVersion: '0.1.0',
      server: { name: 'test', version: '0.1.0' },
      endpoints: {
        resourceTypes: '/v1/resource-types',
        kinds: '/v1/kinds',
        inspect: '/v1/inspect',
        validate: '/v1/validate',
        plan: '/v1/plans',
        approve: '/v1/plans/{planId}/approve',
        apply: '/v1/plans/{planId}/apply',
        verify: '/v1/operations/{operationId}/verify',
        operations: '/v1/operations/{operationId}',
        audit: '/v1/audit',
      },
      features: {
        planBeforeApply: true,
        signedPlans: true,
        idempotency: true,
        verification: true,
        auditLog: true,
        policyEvaluation: true,
        destructiveChanges: false,
        driftDetection: true,
      },
      authentication: ['bearer'],
      limits: {
        maxDocumentBytes: 1000,
        maxDocumentDepth: 10,
        maxResources: 10,
        maxChanges: 10,
        planTtlSeconds: 900,
      },
    })

    expect(output).toContain('DSP SERVER')
    expect(output).toContain('planBeforeApply')
    expect(output).toContain('destructiveChanges')
  })

  it('renders audit events with sequence, action and actor', () => {
    const output = renderAudit([
      {
        id: 'evt_1',
        sequence: 1,
        timestamp: '2026-07-29T18:00:00.000Z',
        actor: { type: 'agent', id: 'demo-agent' },
        action: 'plan.create',
        outcome: 'success',
        planId: plan.metadata.id,
        metadata: {},
        previousEventHash: null,
        eventHash: `sha256:${'c'.repeat(64)}`,
      },
    ])
    expect(output).toContain('plan.create')
    expect(output).toContain('agent:demo-agent')
    expect(output).toContain(plan.metadata.id)
  })
})

describe('DspClient against a real server', () => {
  let app: FastifyInstance
  let bundle: RuntimeBundle
  let backend: MockBackend
  let client: DspClient

  beforeEach(async () => {
    backend = new MockBackend(':memory:')
    bundle = createRuntime({
      providers: [new MockProvider({ backend })],
      policyBundle: EMPTY_POLICY_BUNDLE,
      logger: silentLogger,
      config: { environment: 'test', tenant: 'local' },
    })
    app = await createServer({
      runtime: bundle.runtime,
      authToken: 'cli-token',
      logLevel: 'silent',
    })
    await app.listen({ host: '127.0.0.1', port: 0 })

    const address = app.server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    client = new DspClient({
      server: `http://127.0.0.1:${port}`,
      token: 'cli-token',
      actorId: 'cli-test',
      actorType: 'agent',
    })
  })

  afterEach(async () => {
    await app.close()
    bundle.close()
    backend.close()
  })

  it('authenticates and reads the manifest', async () => {
    expect((await client.manifest()).protocol).toBe('dsp')
    expect((await client.health()).status).toBe('ok')
  })

  it('drives the whole lifecycle', async () => {
    expect((await client.validate(desiredState)).valid).toBe(true)
    expect((await client.inspect(desiredState)).revision).toBe('empty')

    const plan = await client.plan(desiredState)
    expect(plan.summary.create).toBe(2)

    const fetched = await client.getPlan(plan.metadata.id)
    expect(fetched.metadata.planHash).toBe(plan.metadata.planHash)

    await client.approve(plan.metadata.id, {
      approvedBy: 'reviewer',
      reason: 'Reviewed plan',
      planHash: plan.metadata.planHash,
    })

    const operation = await client.apply(plan.metadata.id, { idempotencyKey: 'cli-key' })
    expect(operation.status).toBe('completed')

    expect((await client.operation(operation.id)).id).toBe(operation.id)
    expect((await client.verify(operation.id)).status).toBe('satisfied')
    expect((await client.audit({ limit: 5 })).items.length).toBeGreaterThan(0)
    expect((await client.verifyAuditChain()).valid).toBe(true)
  })

  it('records the actor it was configured with', async () => {
    await client.validate(desiredState)
    const events = (await client.audit({ limit: 1 })).items
    expect(events[0]?.actor).toEqual({ type: 'agent', id: 'cli-test' })
  })

  it('sends the idempotency key, so a repeated apply returns the same operation', async () => {
    const plan = await client.plan(desiredState)
    const first = await client.apply(plan.metadata.id, { idempotencyKey: 'repeat' })
    const second = await client.apply(plan.metadata.id, { idempotencyKey: 'repeat' })
    expect(second.id).toBe(first.id)
  })

  it('sends If-Match through to the drift check', async () => {
    const plan = await client.plan(desiredState)
    try {
      await client.apply(plan.metadata.id, {
        idempotencyKey: 'k',
        ifMatch: `sha256:${'0'.repeat(64)}`,
      })
      expect.unreachable('a wrong revision must be refused')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('STATE_DRIFT_DETECTED')
    }
  })

  it('turns a server error body back into a DSP error with its details', async () => {
    try {
      await client.getPlan(`plan_${'0'.repeat(24)}`)
      expect.unreachable('an unknown plan must be reported')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('PLAN_NOT_FOUND')
      expect(error.httpStatus).toBe(404)
      expect(error.details?.['planId']).toBe(`plan_${'0'.repeat(24)}`)
    }
  })

  it('reports an unauthenticated client as UNAUTHORIZED', async () => {
    const address = app.server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const anonymous = new DspClient({ server: `http://127.0.0.1:${port}` })

    try {
      await anonymous.resourceTypes()
      expect.unreachable('an anonymous client must be refused')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('UNAUTHORIZED')
    }
  })

  it('reports an unreachable server as a retryable transport failure', async () => {
    const unreachable = new DspClient({ server: 'http://127.0.0.1:1', timeoutMs: 500 })
    try {
      await unreachable.manifest()
      expect.unreachable('an unreachable server must be reported')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('PROVIDER_ERROR')
      expect(error.retryable).toBe(true)
    }
  })

  it('never returns a sensitive attribute value to the client', async () => {
    const plan = await client.plan(desiredState)
    expect(JSON.stringify(plan)).not.toContain(CLI_CANARY)
    expect(containsSensitiveData(plan)).toBe(false)
  })
})

describe('command surface', () => {
  it('documents every command the protocol needs', () => {
    const program = buildProgram()
    const commands = program.commands.map((command) => command.name()).sort()

    expect(commands).toEqual([
      'apply',
      'approve',
      'audit',
      'cancel',
      'discover',
      'inspect',
      'plan',
      'show',
      'status',
      'validate',
      'verify',
    ])
  })

  it('makes apply require an explicit confirmation flag', () => {
    const apply = buildProgram().commands.find((command) => command.name() === 'apply')
    const flags = apply?.options.map((option) => option.long)
    expect(flags).toContain('--confirm')
    expect(flags).toContain('--idempotency-key')
    expect(flags).toContain('--if-match')
  })

  it('exposes the server and token as global options', () => {
    const flags = buildProgram().options.map((option) => option.long)
    expect(flags).toContain('--server')
    expect(flags).toContain('--token')
    expect(flags).toContain('--json')
    expect(flags).toContain('--no-color')
  })

  it('nests audit verify under audit', () => {
    const audit = buildProgram().commands.find((command) => command.name() === 'audit')
    expect(audit?.commands.map((command) => command.name())).toEqual(['verify'])
  })

  it('requires a file for the document-driven commands', () => {
    for (const name of ['validate', 'inspect', 'plan']) {
      const command = buildProgram().commands.find((item) => item.name() === name)
      const file = command?.options.find((option) => option.long === '--file')
      expect(file?.required, name).toBe(true)
    }
  })
})
