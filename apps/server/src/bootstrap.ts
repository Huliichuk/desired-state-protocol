import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PolicyBundle } from '@dsp/protocol'
import { DSPRuntime, SqliteRuntimeStore, createLogger } from '@dsp/core'
import { defaultPolicyBundle, loadPolicyBundleFromDirectory } from '@dsp/policy-engine'
import { MockBackend, MockProvider } from '@dsp/provider-mock'
import { createSecretStore } from '@dsp/secret-store'
import type { ServerEnv } from './env.js'
import { SERVER_NAME, SERVER_VERSION } from './version.js'

export interface Bootstrapped {
  runtime: DSPRuntime
  close(): void
  policyBundle: PolicyBundle
}

/**
 * Wires the runtime from environment configuration. This is the only place that
 * decides which providers a server exposes.
 */
export async function bootstrap(env: ServerEnv): Promise<Bootstrapped> {
  await Promise.all([ensureDirectory(env.runtimeDatabase), ensureDirectory(env.mockDatabase)])

  const logger = createLogger({ level: env.logLevel, pretty: env.pretty })
  const store = new SqliteRuntimeStore(env.runtimeDatabase)
  const backend = new MockBackend(env.mockDatabase)
  const policyBundle =
    env.policyDirectory === null
      ? defaultPolicyBundle()
      : await loadPolicyBundleFromDirectory(env.policyDirectory)

  const runtime = new DSPRuntime({
    providers: [new MockProvider({ backend })],
    store,
    auditStore: store,
    secretStore: createSecretStore(env.secretStore),
    policyBundle,
    logger,
    config: {
      environment: env.environment,
      tenant: env.tenant,
      limits: env.limits,
      allowDestructive: env.allowDestructive,
      server: { name: SERVER_NAME, version: SERVER_VERSION },
    },
  })

  return {
    runtime,
    policyBundle,
    close: () => {
      backend.close()
      store.close()
    },
  }
}

async function ensureDirectory(filePath: string): Promise<void> {
  if (filePath === ':memory:') return
  await mkdir(dirname(filePath), { recursive: true })
}
