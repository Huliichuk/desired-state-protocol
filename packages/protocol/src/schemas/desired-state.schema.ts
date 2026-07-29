import type { JsonSchema } from '../types/common.js'
import { DSP_API_VERSION } from '../version.js'

/**
 * The envelope every Desired State document MUST satisfy. `spec` is validated
 * separately against the schema published by the kind's provider.
 */
export const desiredStateSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://dsp.dev/schemas/v1alpha1/desired-state.schema.json',
  title: 'DSP Desired State Document',
  type: 'object',
  additionalProperties: false,
  required: ['apiVersion', 'kind', 'metadata', 'spec'],
  properties: {
    apiVersion: { const: DSP_API_VERSION },
    kind: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z][A-Za-z0-9._-]*$',
    },
    metadata: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 253,
          pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$',
        },
        namespace: {
          type: 'string',
          minLength: 1,
          maxLength: 63,
          pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$',
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string', maxLength: 256 },
          propertyNames: { maxLength: 128 },
        },
        annotations: {
          type: 'object',
          additionalProperties: { type: 'string', maxLength: 4096 },
          propertyNames: { maxLength: 128 },
        },
        requestId: { type: 'string', maxLength: 128 },
      },
    },
    spec: { type: 'object' },
  },
}

export const secretReferenceSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://dsp.dev/schemas/v1alpha1/secret-reference.schema.json',
  title: 'DSP Secret Reference',
  type: 'object',
  additionalProperties: false,
  required: ['secretRef'],
  properties: {
    secretRef: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 253 },
        key: { type: 'string', minLength: 1, maxLength: 253 },
        version: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
  },
}
