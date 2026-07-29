import type { PolicyBundle } from '@dsp/protocol'
import { defaultPolicyBundle } from '@dsp/policy-engine'
import type { DSPProvider, Logger } from '@dsp/provider-sdk'
import { MemorySecretStore, type SecretStore } from '@dsp/secret-store'
import type { RuntimeConfig } from './config.js'
import { createLogger } from './logger.js'
import { DSPRuntime } from './runtime.js'
import { SqliteRuntimeStore } from './store/sqlite-store.js'

export interface CreateRuntimeOptions {
  providers: readonly DSPProvider[]
  /** SQLite path. `:memory:` (the default) keeps everything in-process. */
  databasePath?: string
  secretStore?: SecretStore
  policyBundle?: PolicyBundle
  config?: Partial<RuntimeConfig>
  logger?: Logger
  now?: () => Date
}

export interface RuntimeBundle {
  runtime: DSPRuntime
  store: SqliteRuntimeStore
  close(): void
}

/**
 * Wires a complete runtime with the reference implementations. Everything it
 * chooses can be replaced by constructing `DSPRuntime` directly.
 */
export function createRuntime(options: CreateRuntimeOptions): RuntimeBundle {
  const store = new SqliteRuntimeStore(options.databasePath ?? ':memory:', options.now)
  const runtime = new DSPRuntime({
    providers: options.providers,
    store,
    auditStore: store,
    secretStore: options.secretStore ?? new MemorySecretStore(),
    policyBundle: options.policyBundle ?? defaultPolicyBundle(),
    ...(options.config === undefined ? {} : { config: options.config }),
    logger: options.logger ?? createLogger(),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  return {
    runtime,
    store,
    close: () => store.close(),
  }
}
