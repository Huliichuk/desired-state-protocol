import { randomBytes } from 'node:crypto'
import { DEFAULT_LIMITS, DSPError, type ProtocolLimits } from '@dsp/protocol'
import type { SecretStoreConfig } from '@dsp/secret-store'

export interface ServerEnv {
  host: string
  port: number
  authToken: string
  authTokenGenerated: boolean
  environment: string
  tenant: string
  runtimeDatabase: string
  mockDatabase: string
  policyDirectory: string | null
  secretStore: SecretStoreConfig
  allowDestructive: boolean
  limits: ProtocolLimits
  logLevel: string
  pretty: boolean
}

function readInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim().length === 0) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new DSPError('INTERNAL_ERROR', `${name} must be a positive integer, got "${value}"`)
  }
  return parsed
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function readServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const configuredToken = env['DSP_AUTH_TOKEN']
  const authTokenGenerated = configuredToken === undefined || configuredToken.trim().length === 0
  // Secure by default: an unset token becomes a fresh random one that is
  // printed once, rather than an open server.
  const authToken = authTokenGenerated
    ? randomBytes(24).toString('base64url')
    : configuredToken.trim()

  const secretStoreKind = (env['DSP_SECRET_STORE'] ?? 'env').trim()
  if (secretStoreKind !== 'env' && secretStoreKind !== 'encrypted-file') {
    throw new DSPError(
      'INTERNAL_ERROR',
      `DSP_SECRET_STORE must be "env" or "encrypted-file", got "${secretStoreKind}"`,
    )
  }

  const secretStore: SecretStoreConfig =
    secretStoreKind === 'env'
      ? { kind: 'env' }
      : {
          kind: 'encrypted-file',
          filePath: env['DSP_SECRET_FILE'] ?? '.dsp/secrets.json',
          masterKey: requireMasterKey(env['DSP_SECRET_MASTER_KEY']),
        }

  return {
    host: env['DSP_HOST'] ?? '127.0.0.1',
    port: readInt(env['DSP_PORT'], 4040, 'DSP_PORT'),
    authToken,
    authTokenGenerated,
    environment: env['DSP_ENVIRONMENT'] ?? 'local',
    tenant: env['DSP_TENANT'] ?? 'local',
    runtimeDatabase: env['DSP_DATABASE'] ?? '.dsp/runtime.sqlite',
    mockDatabase: env['DSP_MOCK_DATABASE'] ?? '.dsp/mock.sqlite',
    policyDirectory: env['DSP_POLICY_DIR'] ?? null,
    secretStore,
    allowDestructive: readBool(env['DSP_ALLOW_DESTRUCTIVE'], false),
    limits: {
      ...DEFAULT_LIMITS,
      maxDocumentBytes: readInt(
        env['DSP_MAX_DOCUMENT_BYTES'],
        DEFAULT_LIMITS.maxDocumentBytes,
        'DSP_MAX_DOCUMENT_BYTES',
      ),
      planTtlSeconds: readInt(
        env['DSP_PLAN_TTL_SECONDS'],
        DEFAULT_LIMITS.planTtlSeconds,
        'DSP_PLAN_TTL_SECONDS',
      ),
      providerCallTimeoutMs: readInt(
        env['DSP_PROVIDER_TIMEOUT_MS'],
        DEFAULT_LIMITS.providerCallTimeoutMs,
        'DSP_PROVIDER_TIMEOUT_MS',
      ),
    },
    logLevel: env['DSP_LOG_LEVEL'] ?? 'info',
    pretty: readBool(env['DSP_LOG_PRETTY'], false),
  }
}

function requireMasterKey(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new DSPError(
      'INTERNAL_ERROR',
      'DSP_SECRET_MASTER_KEY is required when DSP_SECRET_STORE=encrypted-file',
    )
  }
  return value
}
