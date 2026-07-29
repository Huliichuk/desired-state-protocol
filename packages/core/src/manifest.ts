import { DSP_PROTOCOL_VERSION, type DSPManifest } from '@dsp/protocol'
import type { RuntimeConfig } from './config.js'

/**
 * The discovery document. An agent reads this once and knows the whole surface:
 * where to plan, what the runtime refuses to do, and what limits apply.
 */
export function buildManifest(config: RuntimeConfig): DSPManifest {
  return {
    protocol: 'dsp',
    protocolVersion: DSP_PROTOCOL_VERSION,
    server: {
      name: config.server.name,
      version: config.server.version,
    },
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
      destructiveChanges: config.allowDestructive,
      driftDetection: true,
    },
    authentication: ['bearer'],
    limits: {
      maxDocumentBytes: config.limits.maxDocumentBytes,
      maxDocumentDepth: config.limits.maxDocumentDepth,
      maxResources: config.limits.maxResources,
      maxChanges: config.limits.maxChanges,
      planTtlSeconds: config.limits.planTtlSeconds,
    },
  }
}
