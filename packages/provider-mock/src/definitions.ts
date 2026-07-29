import type { KindDefinition, ResourceTypeDefinition } from '@dsp/protocol'
import { MOCK_KIND, MOCK_PROVIDER_NAME, MOCK_RESOURCE_TYPES } from './types.js'

const secretRef = {
  type: 'object',
  additionalProperties: false,
  required: ['secretRef'],
  properties: {
    secretRef: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        key: { type: 'string', minLength: 1 },
        version: { type: 'string', minLength: 1 },
      },
    },
  },
}

export const mockWorkspaceSpecSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://dsp.dev/schemas/v1alpha1/mock-workspace.spec.schema.json',
  title: 'MockWorkspace spec',
  type: 'object',
  additionalProperties: false,
  properties: {
    credentials: secretRef,
    simulate: {
      type: 'object',
      additionalProperties: false,
      properties: {
        failResourceKey: { type: 'string' },
        failureMode: { enum: ['retryable', 'permanent', 'timeout'] },
        failAttempts: { type: 'integer', minimum: 1 },
        driftResourceKey: { type: 'string' },
      },
    },
    databases: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'engine', 'region'],
        properties: {
          name: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$', maxLength: 63 },
          engine: { enum: ['postgres', 'mysql', 'sqlite'] },
          region: { type: 'string', minLength: 1, maxLength: 63 },
          sizeGb: { type: 'integer', minimum: 1, maximum: 4096 },
          tables: {
            type: 'array',
            maxItems: 200,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'columns'],
              properties: {
                name: { type: 'string', pattern: '^[a-z0-9_]+$', maxLength: 63 },
                rowLimit: { type: 'integer', minimum: 1 },
                columns: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 100,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['name', 'type'],
                    properties: {
                      name: { type: 'string', pattern: '^[a-z0-9_]+$', maxLength: 63 },
                      type: { enum: ['text', 'integer', 'boolean', 'timestamp', 'json'] },
                      nullable: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    users: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['email', 'role'],
        properties: {
          email: {
            type: 'string',
            // A pattern rather than `format: email`: formats are annotations in
            // JSON Schema, so relying on one would not actually validate.
            pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
            minLength: 3,
            maxLength: 254,
          },
          role: { enum: ['admin', 'member', 'viewer'] },
          displayName: { type: 'string', maxLength: 128 },
          apiToken: { type: 'string', maxLength: 512 },
        },
      },
    },
    subscriptions: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['user', 'plan', 'amountCents', 'currency'],
        properties: {
          user: { type: 'string', minLength: 3, maxLength: 254 },
          plan: { type: 'string', minLength: 1, maxLength: 64 },
          amountCents: { type: 'integer', minimum: 0, maximum: 100_000_000 },
          currency: { type: 'string', pattern: '^[a-z]{3}$' },
          active: { type: 'boolean' },
        },
      },
    },
  },
}

export const mockKindDefinition: KindDefinition = {
  kind: MOCK_KIND,
  provider: MOCK_PROVIDER_NAME,
  description:
    'A synthetic workspace used to exercise the full DSP lifecycle without external APIs',
  specSchema: mockWorkspaceSpecSchema,
  resourceTypes: Object.values(MOCK_RESOURCE_TYPES),
}

export const mockResourceTypes: ResourceTypeDefinition[] = [
  {
    name: MOCK_RESOURCE_TYPES.database,
    provider: MOCK_PROVIDER_NAME,
    description: 'A logical database',
    capabilities: { inspect: true, plan: true, apply: true, verify: true, delete: false },
    identityFields: ['name'],
    immutableFields: ['engine'],
    sensitiveFields: [],
    attributeSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'engine', 'region'],
      properties: {
        name: { type: 'string' },
        engine: { enum: ['postgres', 'mysql', 'sqlite'] },
        region: { type: 'string' },
        sizeGb: { type: 'integer' },
      },
    },
  },
  {
    name: MOCK_RESOURCE_TYPES.table,
    provider: MOCK_PROVIDER_NAME,
    description: 'A table inside a mock database',
    // The only deletable mock resource type, so that a runtime configured with
    // allowDestructive has something to exercise. Databases, members and
    // subscriptions stay undeletable on purpose.
    capabilities: { inspect: true, plan: true, apply: true, verify: true, delete: true },
    identityFields: ['database', 'name'],
    immutableFields: ['database', 'columns[].type'],
    sensitiveFields: [],
    attributeSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['database', 'name', 'columns'],
      properties: {
        database: { type: 'string' },
        name: { type: 'string' },
        rowLimit: { type: 'integer' },
        columns: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  {
    name: MOCK_RESOURCE_TYPES.user,
    provider: MOCK_PROVIDER_NAME,
    description: 'A workspace member',
    capabilities: { inspect: true, plan: true, apply: true, verify: true, delete: false },
    identityFields: ['email'],
    immutableFields: ['email'],
    sensitiveFields: ['apiToken'],
    riskFactors: { permissionScope: true },
    attributeSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['email', 'role'],
      properties: {
        email: { type: 'string' },
        role: { enum: ['admin', 'member', 'viewer'] },
        displayName: { type: 'string' },
        apiToken: { type: 'string' },
      },
    },
  },
  {
    name: MOCK_RESOURCE_TYPES.subscription,
    provider: MOCK_PROVIDER_NAME,
    description: 'A recurring charge attached to a workspace member',
    capabilities: { inspect: true, plan: true, apply: true, verify: true, delete: false },
    identityFields: ['user'],
    immutableFields: ['currency'],
    sensitiveFields: [],
    riskFactors: { financial: true, externallyVisible: true },
    attributeSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['user', 'plan', 'amountCents', 'currency'],
      properties: {
        user: { type: 'string' },
        plan: { type: 'string' },
        amountCents: { type: 'integer' },
        currency: { type: 'string' },
        active: { type: 'boolean' },
      },
    },
  },
]
