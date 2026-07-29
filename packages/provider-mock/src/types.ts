import type { SecretRefHolder } from '@dsp/protocol'

export type MockFailureMode = 'retryable' | 'permanent' | 'timeout'

export interface MockSimulation {
  /** Resource key whose apply should fail. */
  failResourceKey?: string
  failureMode?: MockFailureMode
  /** Number of leading attempts that fail before the change succeeds. */
  failAttempts?: number
  /** Resource key whose stored state is corrupted right after a successful apply. */
  driftResourceKey?: string
}

export interface MockColumn {
  name: string
  type: 'text' | 'integer' | 'boolean' | 'timestamp' | 'json'
  nullable?: boolean
}

export interface MockTable {
  name: string
  columns: MockColumn[]
  rowLimit?: number
}

export interface MockDatabase {
  name: string
  engine: 'postgres' | 'mysql' | 'sqlite'
  region: string
  sizeGb?: number
  tables?: MockTable[]
}

export interface MockUser {
  email: string
  role: 'admin' | 'member' | 'viewer'
  displayName?: string
  /** Sensitive: never appears in plans, audit events or API responses. */
  apiToken?: string
}

export interface MockSubscription {
  user: string
  plan: string
  amountCents: number
  currency: string
  active?: boolean
}

export interface MockWorkspaceSpec {
  credentials?: SecretRefHolder
  simulate?: MockSimulation
  databases?: MockDatabase[]
  users?: MockUser[]
  subscriptions?: MockSubscription[]
}

export interface StoredResource {
  resourceType: string
  key: string
  attributes: Record<string, unknown>
  externalId: string
  revision: string
  updatedAt: string
}

export interface MockWorkspaceState {
  resources: StoredResource[]
}

export const MOCK_KIND = 'MockWorkspace'
export const MOCK_PROVIDER_NAME = 'mock'

export const MOCK_RESOURCE_TYPES = {
  database: 'mock.database',
  table: 'mock.table',
  user: 'mock.user',
  subscription: 'mock.subscription',
} as const
