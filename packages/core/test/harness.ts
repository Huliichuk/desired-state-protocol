import {
  DEFAULT_LIMITS,
  DSP_API_VERSION,
  type Actor,
  type DesiredStateDocument,
  type PolicyBundle,
  type PolicyDocument,
  type ProtocolLimits,
} from '@dsp/protocol'
import { NO_RETRY, type RetryOptions } from '@dsp/execution-engine'
import { EMPTY_POLICY_BUNDLE } from '@dsp/policy-engine'
import { silentLogger } from '@dsp/provider-sdk'
import { MemorySecretStore, type SecretStore } from '@dsp/secret-store'
import { MockBackend, MockProvider, type MockWorkspaceSpec } from '@dsp/provider-mock'
import { DSPRuntime, SqliteRuntimeStore } from '@dsp/core'

export const AGENT: Actor = { type: 'agent', id: 'test-agent' }
export const HUMAN: Actor = { type: 'human', id: 'reviewer' }

export interface Harness {
  runtime: DSPRuntime
  store: SqliteRuntimeStore
  backend: MockBackend
  provider: MockProvider
  /** Moves the injected clock forward. */
  advance(ms: number): void
  now(): Date
  close(): void
}

export interface HarnessOptions {
  policyBundle?: PolicyBundle
  environment?: string
  allowDestructive?: boolean
  limits?: Partial<ProtocolLimits>
  retry?: RetryOptions
  secretStore?: SecretStore
  start?: Date
  /** File-backed SQLite, for tests that need a second connection to the data. */
  storePath?: string
}

/**
 * A complete runtime over real SQLite (in memory) and the real mock provider.
 * Only the clock and the retry sleep are faked, so tests exercise production code
 * paths without waiting on wall-clock time.
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  let clock = options.start ?? new Date('2026-07-29T18:00:00.000Z')
  const now = (): Date => clock

  const store = new SqliteRuntimeStore(options.storePath ?? ':memory:', now)
  const backend = new MockBackend(':memory:', now)
  const provider = new MockProvider({ backend })

  const runtime = new DSPRuntime({
    providers: [provider],
    store,
    auditStore: store,
    secretStore: options.secretStore ?? new MemorySecretStore({ 'mock-api': 'mock-api-value' }),
    policyBundle: options.policyBundle ?? EMPTY_POLICY_BUNDLE,
    logger: silentLogger,
    now,
    // Retries must not spend real time.
    sleep: async () => undefined,
    config: {
      environment: options.environment ?? 'test',
      tenant: 'local',
      allowDestructive: options.allowDestructive ?? false,
      retry: options.retry ?? NO_RETRY,
      limits: { ...DEFAULT_LIMITS, ...options.limits },
      server: { name: 'test runtime', version: '0.1.0' },
    },
  })

  return {
    runtime,
    store,
    backend,
    provider,
    now,
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms)
    },
    close: () => {
      backend.close()
      store.close()
    },
  }
}

export function document(
  spec: MockWorkspaceSpec,
  name = 'demo',
): DesiredStateDocument<MockWorkspaceSpec> {
  return {
    apiVersion: DSP_API_VERSION,
    kind: 'MockWorkspace',
    metadata: { name },
    spec,
  }
}

/** A workspace with one database, one table, one user and one subscription. */
export const BASE_SPEC: MockWorkspaceSpec = {
  databases: [
    {
      name: 'main',
      engine: 'postgres',
      region: 'eu-central-1',
      sizeGb: 20,
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'text' },
            { name: 'email', type: 'text' },
          ],
        },
      ],
    },
  ],
  users: [{ email: 'founder@example.com', role: 'admin' }],
  subscriptions: [{ user: 'founder@example.com', plan: 'pro', amountCents: 2900, currency: 'eur' }],
}

export function policy(name: string, ...rules: PolicyDocument['spec']['rules']): PolicyDocument {
  return {
    apiVersion: DSP_API_VERSION,
    kind: 'Policy',
    metadata: { name },
    spec: { rules },
  }
}

/** Requires an approval for anything touching a workspace member. */
export const APPROVAL_POLICY: PolicyBundle = {
  policies: [
    policy('needs-approval', {
      id: 'approve-user-changes',
      when: { resourceType: 'mock.user' },
      effect: 'requireApproval',
      message: 'Membership changes require approval',
      minApprovals: 1,
    }),
  ],
}

export const WORKSPACE = { namespace: 'default', workspace: 'demo' }
