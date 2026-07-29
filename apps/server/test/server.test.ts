import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DSP_API_VERSION,
  createSchemaValidator,
  type DSPPlan,
  type JsonSchema,
  type OperationRecord,
} from '@dsp/protocol'
import { createRuntime, type RuntimeBundle } from '@dsp/core'
import { EMPTY_POLICY_BUNDLE } from '@dsp/policy-engine'
import { MemorySecretStore } from '@dsp/secret-store'
import { MockBackend, MockProvider, type MockWorkspaceSpec } from '@dsp/provider-mock'
import { silentLogger } from '@dsp/provider-sdk'
import type { FastifyInstance } from 'fastify'
import { createServer } from '../src/server.js'

const TOKEN = 'test-bearer-token'
const schemasDir = fileURLToPath(new URL('../../../schemas/', import.meta.url))

async function publishedSchema(name: string): Promise<JsonSchema> {
  return JSON.parse(await readFile(`${schemasDir}${name}`, 'utf8')) as JsonSchema
}

const spec: MockWorkspaceSpec = {
  databases: [
    {
      name: 'main',
      engine: 'postgres',
      region: 'eu-central-1',
      tables: [{ name: 'users', columns: [{ name: 'id', type: 'text' }] }],
    },
  ],
  users: [{ email: 'founder@example.com', role: 'admin' }],
}

const desiredState = {
  apiVersion: DSP_API_VERSION,
  kind: 'MockWorkspace',
  metadata: { name: 'demo' },
  spec,
}

let app: FastifyInstance
let bundle: RuntimeBundle
let backend: MockBackend

beforeEach(async () => {
  backend = new MockBackend(':memory:')
  bundle = createRuntime({
    providers: [new MockProvider({ backend })],
    policyBundle: EMPTY_POLICY_BUNDLE,
    secretStore: new MemorySecretStore(),
    logger: silentLogger,
    config: { environment: 'test', tenant: 'local' },
  })
  app = await createServer({ runtime: bundle.runtime, authToken: TOKEN, logLevel: 'silent' })
})

afterEach(async () => {
  await app.close()
  bundle.close()
  backend.close()
})

const auth = { authorization: `Bearer ${TOKEN}` }

describe('public endpoints', () => {
  it('serves health without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'ok', protocolVersion: '0.1.0' })
  })

  it('serves the manifest without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/.well-known/dsp' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ protocol: 'dsp' })
  })

  it('publishes a manifest that satisfies the published schema', async () => {
    const validator = createSchemaValidator(await publishedSchema('manifest.schema.json'))
    const result = validator.validate(
      (await app.inject({ method: 'GET', url: '/.well-known/dsp' })).json(),
    )
    expect(result.errors).toEqual([])
  })

  it('advertises the protocol version on every response', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.headers['x-dsp-protocol-version']).toBe('0.1.0')
    expect(response.headers['cache-control']).toBe('no-store')
  })
})

describe('authentication', () => {
  const protected_ = [
    ['GET', '/v1/resource-types'],
    ['GET', '/v1/kinds'],
    ['POST', '/v1/validate'],
    ['POST', '/v1/inspect'],
    ['POST', '/v1/plans'],
    ['GET', '/v1/audit'],
  ] as const

  for (const [method, url] of protected_) {
    it(`refuses ${method} ${url} without a token`, async () => {
      const response = await app.inject({ method, url })
      expect(response.statusCode).toBe(401)
      expect(response.json().error.code).toBe('UNAUTHORIZED')
    })
  }

  it('refuses a wrong token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/resource-types',
      headers: { authorization: 'Bearer not-the-token' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a token of the right length but wrong content', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/resource-types',
      headers: { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` },
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a non-bearer scheme', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/resource-types',
      headers: { authorization: `Basic ${TOKEN}` },
    })
    expect(response.statusCode).toBe(401)
  })

  it('accepts the configured token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/resource-types', headers: auth })
    expect(response.statusCode).toBe(200)
  })
})

describe('discovery', () => {
  it('lists resource types as DSP documents', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/resource-types', headers: auth })
    const items = response.json().items as Array<Record<string, unknown>>

    expect(items).toHaveLength(4)
    expect(items[0]).toMatchObject({ apiVersion: DSP_API_VERSION, kind: 'ResourceType' })
    expect((items[0]?.['spec'] as Record<string, unknown>)['schemaUrl']).toContain(
      '/v1/resource-types/',
    )
  })

  it('describes one resource type and serves its attribute schema', async () => {
    const describe_ = await app.inject({
      method: 'GET',
      url: '/v1/resource-types/mock.database',
      headers: auth,
    })
    expect(describe_.json().metadata.name).toBe('mock.database')
    expect(describe_.json().spec.immutableFields).toEqual(['engine'])

    const schema = await app.inject({
      method: 'GET',
      url: '/v1/resource-types/mock.database/schema',
      headers: auth,
    })
    expect(schema.json().type).toBe('object')
  })

  it('reports an unknown resource type as a 404 with a DSP code', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/resource-types/stripe.product',
      headers: auth,
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('UNKNOWN_RESOURCE_TYPE')
  })

  it('lists kinds and serves a kind spec schema', async () => {
    const kinds = await app.inject({ method: 'GET', url: '/v1/kinds', headers: auth })
    expect(kinds.json().items[0].metadata.name).toBe('MockWorkspace')

    const schema = await app.inject({
      method: 'GET',
      url: '/v1/kinds/MockWorkspace/schema',
      headers: auth,
    })
    expect(schema.json().properties.databases).toBeDefined()
  })

  it('reports an unknown kind as a 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/kinds/Nope', headers: auth })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('UNKNOWN_KIND')
  })
})

describe('the lifecycle over HTTP', () => {
  it('runs validate, plan, apply and verify, and matches the published schemas', async () => {
    const validation = await app.inject({
      method: 'POST',
      url: '/v1/validate',
      headers: auth,
      payload: { desiredState },
    })
    expect(validation.statusCode).toBe(200)
    expect(validation.json().valid).toBe(true)

    const inspect = await app.inject({
      method: 'POST',
      url: '/v1/inspect',
      headers: auth,
      payload: { desiredState },
    })
    expect(inspect.json().revision).toBe('empty')

    const planResponse = await app.inject({
      method: 'POST',
      url: '/v1/plans',
      headers: auth,
      payload: { desiredState },
    })
    expect(planResponse.statusCode).toBe(201)
    const plan = planResponse.json() as DSPPlan

    const planValidator = createSchemaValidator(await publishedSchema('plan.schema.json'))
    expect(planValidator.validate(plan).errors).toEqual([])

    const fetched = await app.inject({
      method: 'GET',
      url: `/v1/plans/${plan.metadata.id}`,
      headers: auth,
    })
    expect(fetched.json().metadata.planHash).toBe(plan.metadata.planHash)

    const approval = await app.inject({
      method: 'POST',
      url: `/v1/plans/${plan.metadata.id}/approve`,
      headers: auth,
      payload: {
        approvedBy: 'reviewer',
        reason: 'Reviewed plan',
        planHash: plan.metadata.planHash,
      },
    })
    expect(approval.statusCode).toBe(200)

    const applyResponse = await app.inject({
      method: 'POST',
      url: `/v1/plans/${plan.metadata.id}/apply`,
      headers: { ...auth, 'idempotency-key': 'http-key-1' },
    })
    expect(applyResponse.statusCode).toBe(200)
    const operation = applyResponse.json() as OperationRecord
    expect(operation.status).toBe('completed')

    const operationValidator = createSchemaValidator(await publishedSchema('result.schema.json'))
    expect(operationValidator.validate(operation).errors).toEqual([])

    const status = await app.inject({
      method: 'GET',
      url: `/v1/operations/${operation.id}`,
      headers: auth,
    })
    expect(status.json().status).toBe('completed')

    const verify = await app.inject({
      method: 'POST',
      url: `/v1/operations/${operation.id}/verify`,
      headers: auth,
    })
    expect(verify.json().status).toBe('satisfied')
  })

  it('requires an idempotency key on apply', async () => {
    const plan = (
      await app.inject({
        method: 'POST',
        url: '/v1/plans',
        headers: auth,
        payload: { desiredState },
      })
    ).json() as DSPPlan

    const response = await app.inject({
      method: 'POST',
      url: `/v1/plans/${plan.metadata.id}/apply`,
      headers: auth,
    })
    expect(response.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })

  it('passes If-Match through to the drift check', async () => {
    const plan = (
      await app.inject({
        method: 'POST',
        url: '/v1/plans',
        headers: auth,
        payload: { desiredState },
      })
    ).json() as DSPPlan

    const response = await app.inject({
      method: 'POST',
      url: `/v1/plans/${plan.metadata.id}/apply`,
      headers: { ...auth, 'idempotency-key': 'k', 'if-match': 'sha256:' + 'a'.repeat(64) },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('STATE_DRIFT_DETECTED')
  })

  it('returns a validation result rather than an error for an invalid document', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/validate',
      headers: auth,
      payload: { desiredState: { ...desiredState, kind: 'Unknown' } },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().valid).toBe(false)
  })

  it('reports an unknown plan and an unknown operation as 404', async () => {
    expect(
      (await app.inject({ method: 'GET', url: `/v1/plans/plan_${'0'.repeat(24)}`, headers: auth }))
        .statusCode,
    ).toBe(404)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/operations/op_${'0'.repeat(24)}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404)
  })

  it('cancels an operation only while it can still be cancelled', async () => {
    const plan = (
      await app.inject({
        method: 'POST',
        url: '/v1/plans',
        headers: auth,
        payload: { desiredState },
      })
    ).json() as DSPPlan
    const operation = (
      await app.inject({
        method: 'POST',
        url: `/v1/plans/${plan.metadata.id}/apply`,
        headers: { ...auth, 'idempotency-key': 'k' },
      })
    ).json() as OperationRecord

    const response = await app.inject({
      method: 'POST',
      url: `/v1/operations/${operation.id}/cancel`,
      headers: auth,
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('CANCELLED')
  })
})

describe('the uniform error envelope', () => {
  const expectEnvelope = (body: Record<string, unknown>): void => {
    expect(Object.keys(body)).toEqual(['error'])
    const error = body['error'] as Record<string, unknown>
    expect(typeof error['code']).toBe('string')
    expect(typeof error['message']).toBe('string')
    expect(typeof error['retryable']).toBe('boolean')
    expect(typeof error['requestId']).toBe('string')
    expect(JSON.stringify(body)).not.toContain('at Object.')
    expect(body).not.toHaveProperty('stack')
  }

  it('uses the envelope for an unauthorized request', async () => {
    expectEnvelope((await app.inject({ method: 'GET', url: '/v1/audit' })).json())
  })

  it('uses the envelope for an unknown resource', async () => {
    expectEnvelope(
      (await app.inject({ method: 'GET', url: '/v1/kinds/Nope', headers: auth })).json(),
    )
  })

  it('uses the envelope for a route that does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/nonsense', headers: auth })
    expect(response.statusCode).toBe(404)
    expectEnvelope(response.json())
  })

  it('uses the envelope for a body that fails the request schema', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/plans/plan_${'0'.repeat(24)}/approve`,
      headers: auth,
      payload: { approvedBy: 'x', reason: 'y', planHash: 'not-a-hash' },
    })
    expect(response.statusCode).toBe(422)
    expectEnvelope(response.json())
    expect(response.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('uses the envelope for malformed JSON', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/validate',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{ not json',
    })
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expectEnvelope(response.json())
  })

  it('gives every response a distinct request id', async () => {
    const first = (await app.inject({ method: 'GET', url: '/v1/audit' })).json()
    const second = (await app.inject({ method: 'GET', url: '/v1/audit' })).json()
    expect(first.error.requestId).not.toBe(second.error.requestId)
    expect(first.error.requestId).toMatch(/^req_[0-9a-f]{16}$/)
  })
})

describe('audit endpoints', () => {
  it('lists events, verifies the chain and reads one event', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/validate',
      headers: auth,
      payload: { desiredState },
    })

    const list = await app.inject({ method: 'GET', url: '/v1/audit', headers: auth })
    const events = list.json().items as Array<{ id: string }>
    expect(events.length).toBeGreaterThan(0)

    // The static route must win over the parameterized one.
    const verify = await app.inject({ method: 'GET', url: '/v1/audit/verify', headers: auth })
    expect(verify.json()).toMatchObject({ valid: true })

    const single = await app.inject({
      method: 'GET',
      url: `/v1/audit/${events[0]?.id}`,
      headers: auth,
    })
    expect(single.json().id).toBe(events[0]?.id)
  })

  it('applies query filters', async () => {
    await app.inject({ method: 'POST', url: '/v1/plans', headers: auth, payload: { desiredState } })
    const response = await app.inject({
      method: 'GET',
      url: '/v1/audit?limit=1&action=plan.create',
      headers: auth,
    })
    expect(response.json().items).toHaveLength(1)
    expect(response.json().items[0].action).toBe('plan.create')
  })

  it('rejects a nonsensical query', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/audit?limit=huge', headers: auth })
    expect(response.statusCode).toBe(422)
  })
})

describe('actor attribution', () => {
  it('records the actor the caller declared', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/validate',
      headers: { ...auth, 'x-dsp-actor-type': 'human', 'x-dsp-actor-id': 'taras' },
      payload: { desiredState },
    })

    const events = (await app.inject({ method: 'GET', url: '/v1/audit', headers: auth })).json()
      .items as Array<{ actor: { type: string; id: string } }>
    expect(events[0]?.actor).toEqual({ type: 'human', id: 'taras' })
  })

  it('falls back to an agent identity for an unrecognized actor type', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/validate',
      headers: { ...auth, 'x-dsp-actor-type': 'root', 'x-dsp-actor-id': '' },
      payload: { desiredState },
    })

    const events = (await app.inject({ method: 'GET', url: '/v1/audit', headers: auth })).json()
      .items as Array<{ actor: { type: string; id: string } }>
    expect(events[0]?.actor).toEqual({ type: 'agent', id: 'anonymous' })
  })

  it('does not let actor headers stand in for a token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { 'x-dsp-actor-type': 'system', 'x-dsp-actor-id': 'root' },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('openapi document', () => {
  // The complete surface of DSP 0.1. Both directions are checked, so neither the
  // routes nor the OpenAPI document can drift away from this list unnoticed.
  const ROUTES: Array<['GET' | 'POST', string]> = [
    ['GET', '/health'],
    ['GET', '/.well-known/dsp'],
    ['GET', '/openapi.json'],
    ['GET', '/v1/resource-types'],
    ['GET', '/v1/resource-types/:resourceType'],
    ['GET', '/v1/resource-types/:resourceType/schema'],
    ['GET', '/v1/kinds'],
    ['GET', '/v1/kinds/:kind'],
    ['GET', '/v1/kinds/:kind/schema'],
    ['POST', '/v1/validate'],
    ['POST', '/v1/inspect'],
    ['POST', '/v1/plans'],
    ['GET', '/v1/plans/:planId'],
    ['POST', '/v1/plans/:planId/approve'],
    ['POST', '/v1/plans/:planId/apply'],
    ['GET', '/v1/operations/:operationId'],
    ['POST', '/v1/operations/:operationId/verify'],
    ['POST', '/v1/operations/:operationId/cancel'],
    ['GET', '/v1/audit'],
    ['GET', '/v1/audit/verify'],
    ['GET', '/v1/audit/:eventId'],
  ]

  const toOpenApiPath = (url: string): string => url.replace(/:(\w+)/g, '{$1}')

  it('serves every route the protocol documents', () => {
    for (const [method, url] of ROUTES) {
      expect(app.hasRoute({ method, url }), `${method} ${url} is not served`).toBe(true)
    }
  })

  it('documents every route it serves', async () => {
    const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as {
      openapi: string
      paths: Record<string, Record<string, unknown>>
    }
    expect(document.openapi).toBe('3.1.0')

    for (const [method, url] of ROUTES) {
      const path = document.paths[toOpenApiPath(url)]
      expect(path, `${toOpenApiPath(url)} is served but not documented`).toBeDefined()
      expect(path?.[method.toLowerCase()], `${method} ${url} is not documented`).toBeDefined()
    }
  })

  it('does not document a route it does not serve', async () => {
    const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as {
      paths: Record<string, unknown>
    }
    const served = new Set(ROUTES.map(([, url]) => toOpenApiPath(url)))
    for (const path of Object.keys(document.paths)) {
      expect(served.has(path), `${path} is documented but not served`).toBe(true)
    }
  })

  it('reuses the published DSP schemas rather than restating them', async () => {
    const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as {
      components: { schemas: Record<string, { $id?: string }> }
    }
    expect(document.components.schemas['Plan']?.$id).toContain('plan.schema.json')
    expect(document.components.schemas['Operation']?.$id).toContain('result.schema.json')
  })
})
