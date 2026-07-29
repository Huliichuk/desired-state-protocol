import {
  DSP_PROTOCOL_VERSION,
  desiredStateSchema,
  manifestSchema,
  planSchema,
  policySchema,
  resultSchema,
} from '@dsp/protocol'
import type { DSPRuntime } from '@dsp/core'

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        details: { type: 'object' },
        requestId: { type: 'string' },
      },
    },
  },
}

const errorResponse = (description: string): Record<string, unknown> => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
})

const jsonBody = (schemaRef: string): Record<string, unknown> => ({
  required: true,
  content: { 'application/json': { schema: { $ref: schemaRef } } },
})

const jsonResponse = (description: string, schemaRef?: string): Record<string, unknown> => ({
  description,
  ...(schemaRef === undefined
    ? {}
    : { content: { 'application/json': { schema: { $ref: schemaRef } } } }),
})

/**
 * OpenAPI 3.1 description of the runtime, reusing the published DSP JSON
 * Schemas so the HTTP contract and the protocol contract cannot drift.
 */
export function buildOpenApiDocument(runtime: DSPRuntime): Record<string, unknown> {
  const manifest = runtime.manifest()

  return {
    openapi: '3.1.0',
    info: {
      title: `${manifest.server.name} (DSP ${DSP_PROTOCOL_VERSION})`,
      version: manifest.server.version,
      description:
        'Desired State Protocol runtime. An agent describes what should be true; the runtime plans, validates, applies and verifies the change.',
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
      schemas: {
        Error: errorSchema,
        Manifest: manifestSchema,
        DesiredStateDocument: desiredStateSchema,
        Plan: planSchema,
        Operation: resultSchema,
        Policy: policySchema,
        ValidationResult: {
          type: 'object',
          required: ['valid', 'errors', 'warnings'],
          properties: {
            valid: { type: 'boolean' },
            errors: { type: 'array', items: { $ref: '#/components/schemas/ValidationIssue' } },
            warnings: { type: 'array', items: { $ref: '#/components/schemas/ValidationIssue' } },
          },
        },
        ValidationIssue: {
          type: 'object',
          required: ['code', 'path', 'message'],
          properties: {
            code: { type: 'string' },
            path: { type: 'string' },
            message: { type: 'string' },
          },
        },
        PlanRequest: {
          type: 'object',
          required: ['desiredState'],
          properties: {
            desiredState: { $ref: '#/components/schemas/DesiredStateDocument' },
            options: {
              type: 'object',
              properties: {
                allowDelete: { type: 'boolean' },
                allowReplace: { type: 'boolean' },
                refreshCurrentState: { type: 'boolean' },
              },
            },
          },
        },
        DesiredStateRequest: {
          type: 'object',
          required: ['desiredState'],
          properties: { desiredState: { $ref: '#/components/schemas/DesiredStateDocument' } },
        },
        ApproveRequest: {
          type: 'object',
          required: ['approvedBy', 'reason', 'planHash'],
          properties: {
            approvedBy: { type: 'string' },
            reason: { type: 'string' },
            planHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          },
        },
      },
    },
    paths: {
      '/health': {
        get: {
          summary: 'Liveness probe',
          security: [],
          responses: { '200': jsonResponse('Healthy') },
        },
      },
      '/.well-known/dsp': {
        get: {
          summary: 'Protocol discovery',
          security: [],
          responses: { '200': jsonResponse('The DSP manifest', '#/components/schemas/Manifest') },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'This document',
          security: [],
          responses: { '200': jsonResponse('The OpenAPI description of this runtime') },
        },
      },
      '/v1/resource-types': {
        get: {
          summary: 'List resource types',
          responses: { '200': jsonResponse('Resource types') },
        },
      },
      '/v1/resource-types/{resourceType}': {
        get: {
          summary: 'Describe a resource type',
          parameters: [pathParam('resourceType')],
          responses: {
            '200': jsonResponse('Resource type'),
            '404': errorResponse('Unknown resource type'),
          },
        },
      },
      '/v1/resource-types/{resourceType}/schema': {
        get: {
          summary: 'JSON Schema of a resource type’s attributes',
          parameters: [pathParam('resourceType')],
          responses: {
            '200': jsonResponse('JSON Schema'),
            '404': errorResponse('Unknown resource type'),
          },
        },
      },
      '/v1/kinds': {
        get: { summary: 'List document kinds', responses: { '200': jsonResponse('Kinds') } },
      },
      '/v1/kinds/{kind}': {
        get: {
          summary: 'Describe a document kind',
          parameters: [pathParam('kind')],
          responses: { '200': jsonResponse('Kind'), '404': errorResponse('Unknown kind') },
        },
      },
      '/v1/kinds/{kind}/schema': {
        get: {
          summary: 'JSON Schema of a kind’s spec',
          parameters: [pathParam('kind')],
          responses: { '200': jsonResponse('JSON Schema'), '404': errorResponse('Unknown kind') },
        },
      },
      '/v1/validate': {
        post: {
          summary: 'Validate a Desired State document. Side-effect free.',
          requestBody: jsonBody('#/components/schemas/DesiredStateRequest'),
          responses: {
            '200': jsonResponse('Validation result', '#/components/schemas/ValidationResult'),
            '422': errorResponse('The request body itself is malformed'),
          },
        },
      },
      '/v1/inspect': {
        post: {
          summary: 'Read the current state of the external system. Side-effect free.',
          requestBody: jsonBody('#/components/schemas/DesiredStateRequest'),
          responses: {
            '200': jsonResponse('Current state'),
            '502': errorResponse('Provider error'),
          },
        },
      },
      '/v1/plans': {
        post: {
          summary: 'Create an immutable plan. Side-effect free.',
          requestBody: jsonBody('#/components/schemas/PlanRequest'),
          responses: {
            '201': jsonResponse('The plan', '#/components/schemas/Plan'),
            '422': errorResponse('Invalid document'),
          },
        },
      },
      '/v1/plans/{planId}': {
        get: {
          summary: 'Fetch a stored plan',
          parameters: [pathParam('planId')],
          responses: {
            '200': jsonResponse('The plan', '#/components/schemas/Plan'),
            '404': errorResponse('Unknown plan'),
          },
        },
      },
      '/v1/plans/{planId}/approve': {
        post: {
          summary: 'Approve a specific plan hash',
          parameters: [pathParam('planId')],
          requestBody: jsonBody('#/components/schemas/ApproveRequest'),
          responses: {
            '200': jsonResponse('The approval record'),
            '409': errorResponse('Plan hash mismatch or expired plan'),
          },
        },
      },
      '/v1/plans/{planId}/apply': {
        post: {
          summary: 'Execute a plan. Accepts a plan id only — never a document.',
          parameters: [
            pathParam('planId'),
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'If-Match',
              in: 'header',
              required: false,
              description: 'The current-state revision the caller expects.',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': jsonResponse('The operation', '#/components/schemas/Operation'),
            '202': jsonResponse('The operation was created', '#/components/schemas/Operation'),
            '409': errorResponse('Approval required, expired plan, or state drift'),
            '403': errorResponse('Policy denied the plan'),
          },
        },
      },
      '/v1/operations/{operationId}': {
        get: {
          summary: 'Fetch an operation',
          parameters: [pathParam('operationId')],
          responses: {
            '200': jsonResponse('The operation', '#/components/schemas/Operation'),
            '404': errorResponse('Unknown operation'),
          },
        },
      },
      '/v1/operations/{operationId}/verify': {
        post: {
          summary: 'Re-read the provider state and compare it with the desired state',
          parameters: [pathParam('operationId')],
          responses: { '200': jsonResponse('Verification result') },
        },
      },
      '/v1/operations/{operationId}/cancel': {
        post: {
          summary: 'Request cancellation of a running operation',
          parameters: [pathParam('operationId')],
          responses: {
            '200': jsonResponse('The operation', '#/components/schemas/Operation'),
            '409': errorResponse('Operation already finished'),
          },
        },
      },
      '/v1/audit': {
        get: { summary: 'List audit events', responses: { '200': jsonResponse('Audit events') } },
      },
      '/v1/audit/verify': {
        get: {
          summary: 'Verify the integrity of the audit hash chain',
          responses: { '200': jsonResponse('Chain verification result') },
        },
      },
      '/v1/audit/{eventId}': {
        get: {
          summary: 'Fetch one audit event',
          parameters: [pathParam('eventId')],
          responses: { '200': jsonResponse('Audit event'), '404': errorResponse('Unknown event') },
        },
      },
    },
  }
}

function pathParam(name: string): Record<string, unknown> {
  return { name, in: 'path', required: true, schema: { type: 'string' } }
}
