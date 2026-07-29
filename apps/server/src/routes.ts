import { DSPError, type ResourceTypeDefinition } from '@dsp/protocol'
import type { DSPRuntime } from '@dsp/core'
import type { AuditQuery } from '@dsp/audit'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { actorFrom } from './auth.js'
import { buildOpenApiDocument } from './openapi.js'
import {
  approveBodySchema,
  auditQuerySchema,
  inspectBodySchema,
  parseBody,
  planBodySchema,
  validateBodySchema,
} from './schemas.js'

export interface RouteOptions {
  runtime: DSPRuntime
}

/**
 * Resource types are published as DSP documents rather than bare objects, so a
 * client can treat everything the server returns uniformly.
 */
function resourceTypeDocument(definition: ResourceTypeDefinition): Record<string, unknown> {
  return {
    apiVersion: 'dsp.dev/v1alpha1',
    kind: 'ResourceType',
    metadata: { name: definition.name },
    spec: {
      provider: definition.provider,
      description: definition.description ?? null,
      schemaUrl: `/v1/resource-types/${definition.name}/schema`,
      capabilities: definition.capabilities,
      identityFields: definition.identityFields,
      immutableFields: definition.immutableFields,
      sensitiveFields: definition.sensitiveFields,
      riskFactors: definition.riskFactors ?? {},
    },
  }
}

function requireHeader(
  request: FastifyRequest,
  name: string,
  code: 'IDEMPOTENCY_KEY_REQUIRED',
): string {
  const value = request.headers[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DSPError(code, `The ${name} header is required`, { details: { header: name } })
  }
  return value.trim()
}

export async function registerRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { runtime } = options

  app.get('/health', async () => ({
    status: 'ok',
    protocolVersion: runtime.manifest().protocolVersion,
    environment: runtime.config().environment,
  }))

  app.get('/.well-known/dsp', async () => runtime.manifest())

  app.get('/openapi.json', async () => buildOpenApiDocument(runtime))

  // --- discovery ----------------------------------------------------------

  app.get('/v1/resource-types', async () => ({
    items: runtime.listResourceTypes().map(resourceTypeDocument),
  }))

  app.get<{ Params: { resourceType: string } }>(
    '/v1/resource-types/:resourceType',
    async (request) => resourceTypeDocument(runtime.getResourceType(request.params.resourceType)),
  )

  app.get<{ Params: { resourceType: string } }>(
    '/v1/resource-types/:resourceType/schema',
    async (request) => runtime.getResourceType(request.params.resourceType).attributeSchema,
  )

  app.get('/v1/kinds', async () => ({
    items: runtime.listKinds().map((kind) => ({
      apiVersion: 'dsp.dev/v1alpha1',
      kind: 'Kind',
      metadata: { name: kind.kind },
      spec: {
        provider: kind.provider,
        description: kind.description ?? null,
        schemaUrl: `/v1/kinds/${kind.kind}/schema`,
        resourceTypes: kind.resourceTypes,
      },
    })),
  }))

  app.get<{ Params: { kind: string } }>('/v1/kinds/:kind', async (request) => {
    const kind = runtime.getKind(request.params.kind)
    return {
      apiVersion: 'dsp.dev/v1alpha1',
      kind: 'Kind',
      metadata: { name: kind.kind },
      spec: {
        provider: kind.provider,
        description: kind.description ?? null,
        schemaUrl: `/v1/kinds/${kind.kind}/schema`,
        resourceTypes: kind.resourceTypes,
      },
    }
  })

  app.get<{ Params: { kind: string } }>(
    '/v1/kinds/:kind/schema',
    async (request) => runtime.getKind(request.params.kind).specSchema,
  )

  // --- lifecycle ----------------------------------------------------------

  app.post('/v1/validate', async (request) => {
    const body = parseBody(validateBodySchema, request.body)
    return runtime.validate({
      desiredState: body.desiredState,
      actor: actorFrom(request),
      requestId: String(request.id),
    })
  })

  app.post('/v1/inspect', async (request) => {
    const body = parseBody(inspectBodySchema, request.body)
    return runtime.inspect({
      desiredState: body.desiredState,
      actor: actorFrom(request),
      requestId: String(request.id),
    })
  })

  app.post('/v1/plans', async (request, reply) => {
    const body = parseBody(planBodySchema, request.body)
    const plan = await runtime.plan({
      desiredState: body.desiredState,
      ...(body.options === undefined ? {} : { options: body.options }),
      actor: actorFrom(request),
      requestId: String(request.id),
    })
    return reply.status(201).send(plan)
  })

  app.get<{ Params: { planId: string } }>('/v1/plans/:planId', async (request) =>
    runtime.getPlan(request.params.planId),
  )

  app.post<{ Params: { planId: string } }>('/v1/plans/:planId/approve', async (request) => {
    const body = parseBody(approveBodySchema, request.body)
    return runtime.approve({
      planId: request.params.planId,
      approvedBy: body.approvedBy,
      reason: body.reason,
      planHash: body.planHash,
      actor: actorFrom(request),
      requestId: String(request.id),
    })
  })

  app.post<{ Params: { planId: string } }>('/v1/plans/:planId/apply', async (request, reply) => {
    const idempotencyKey = requireHeader(request, 'idempotency-key', 'IDEMPOTENCY_KEY_REQUIRED')
    const ifMatch = request.headers['if-match']

    const operation = await runtime.apply({
      planId: request.params.planId,
      idempotencyKey,
      ...(typeof ifMatch === 'string' && ifMatch.length > 0 ? { ifMatch } : {}),
      actor: actorFrom(request),
      requestId: String(request.id),
    })

    return reply.status(operation.status === 'created' ? 202 : 200).send(operation)
  })

  // --- operations ---------------------------------------------------------

  app.get<{ Params: { operationId: string } }>('/v1/operations/:operationId', async (request) =>
    runtime.getOperation(request.params.operationId),
  )

  app.post<{ Params: { operationId: string } }>(
    '/v1/operations/:operationId/verify',
    async (request) => runtime.verify(request.params.operationId, actorFrom(request)),
  )

  app.post<{ Params: { operationId: string } }>(
    '/v1/operations/:operationId/cancel',
    async (request) => runtime.cancel(request.params.operationId, actorFrom(request)),
  )

  // --- audit --------------------------------------------------------------

  app.get('/v1/audit', async (request) => {
    const query = parseBody(auditQuerySchema, request.query ?? {})
    const filter: AuditQuery = {}
    if (query.limit !== undefined) filter.limit = query.limit
    if (query.afterSequence !== undefined) filter.afterSequence = query.afterSequence
    if (query.planId !== undefined) filter.planId = query.planId
    if (query.operationId !== undefined) filter.operationId = query.operationId
    if (query.action !== undefined) filter.action = query.action

    return { items: await runtime.audit(filter) }
  })

  // Registered before the parameterized route so `verify` is never read as an id.
  app.get('/v1/audit/verify', async () => runtime.verifyAuditChain())

  app.get<{ Params: { eventId: string } }>('/v1/audit/:eventId', async (request) =>
    runtime.auditEvent(request.params.eventId),
  )
}
