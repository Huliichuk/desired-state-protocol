import {
  DSP_API_VERSION,
  DEFAULT_LIMITS,
  type DesiredStateDocument,
  type ProtocolLimits,
  type SecretReference,
} from '@dsp/protocol'
import { DenyAllSecretResolver, MemorySecretStore, ScopedSecretResolver } from '@dsp/secret-store'
import type { SecretResolver } from '@dsp/secret-store'
import type { ProviderContext, ProviderExecutionContext } from './context.js'
import { silentLogger, type Logger } from './logger.js'

export interface TestContextOptions {
  environment?: string
  namespace?: string
  logger?: Logger
  secrets?: SecretResolver
  /** Convenience: builds a scoped resolver over an in-memory store. */
  secretValues?: Record<string, string>
  signal?: AbortSignal
  limits?: ProtocolLimits
  now?: () => Date
}

export function createTestContext(options: TestContextOptions = {}): ProviderContext {
  const secrets = options.secrets ?? buildResolver(options.secretValues)
  return {
    environment: options.environment ?? 'test',
    namespace: options.namespace ?? 'default',
    logger: options.logger ?? silentLogger,
    secrets,
    signal: options.signal ?? new AbortController().signal,
    limits: options.limits ?? DEFAULT_LIMITS,
    now: options.now ?? (() => new Date('2026-01-01T00:00:00.000Z')),
  }
}

export function createTestExecutionContext(
  options: TestContextOptions & {
    operationId?: string
    idempotencyKey?: string
    attempt?: number
    desired?: DesiredStateDocument
  } = {},
): ProviderExecutionContext {
  return {
    ...createTestContext(options),
    operationId: options.operationId ?? 'op_000000000000000000000000',
    idempotencyKey: options.idempotencyKey ?? 'test-idempotency-key',
    attempt: options.attempt ?? 1,
    desired: options.desired ?? {
      apiVersion: DSP_API_VERSION,
      kind: 'TestKind',
      metadata: { name: 'test' },
      spec: {},
    },
  }
}

function buildResolver(values: Record<string, string> | undefined): SecretResolver {
  if (values === undefined) return new DenyAllSecretResolver()
  const store = new MemorySecretStore(values)
  const references: SecretReference[] = Object.keys(values).map((key) => {
    const [name, secretPart] = key.split('/')
    return secretPart === undefined ? { name: name ?? key } : { name: name ?? key, key: secretPart }
  })
  return new ScopedSecretResolver(store, references)
}
