import { DEFAULT_LIMITS, type ProtocolLimits } from '@dsp/protocol'
import { DEFAULT_RETRY, type RetryOptions } from '@dsp/execution-engine'

export interface ServerInfo {
  name: string
  version: string
}

export interface RuntimeConfig {
  /** Deployment environment. Feeds the risk score and policy scoping. */
  environment: string
  /** Single-tenant in the MVP; part of the idempotency key. */
  tenant: string
  limits: ProtocolLimits
  retry: RetryOptions
  server: ServerInfo
  /** Whether the runtime is willing to execute deletions at all. */
  allowDestructive: boolean
}

export const DEFAULT_SERVER_INFO: ServerInfo = {
  name: 'DSP Reference Runtime',
  version: '0.1.0',
}

export function createRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    environment: overrides.environment ?? 'local',
    tenant: overrides.tenant ?? 'local',
    limits: overrides.limits ?? DEFAULT_LIMITS,
    retry: overrides.retry ?? DEFAULT_RETRY,
    server: overrides.server ?? DEFAULT_SERVER_INFO,
    allowDestructive: overrides.allowDestructive ?? false,
  }
}
