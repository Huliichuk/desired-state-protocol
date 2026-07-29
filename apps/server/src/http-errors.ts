import { DSPError, type DSPErrorPayload, type DSPErrorResponse } from '@dsp/protocol'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Every failure leaves the server in the same shape. Nothing else — no Fastify
 * default body, no stack trace, no provider internals — is ever written.
 */
export function toResponse(
  error: unknown,
  requestId: string,
): { status: number; body: DSPErrorResponse } {
  if (DSPError.isDSPError(error)) {
    return { status: error.httpStatus, body: { error: error.toPayload(requestId) } }
  }

  const payload: DSPErrorPayload = {
    code: 'INTERNAL_ERROR',
    message: 'An unexpected internal error occurred',
    retryable: false,
    requestId,
  }
  return { status: 500, body: { error: payload } }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = String(request.id)

    if (!DSPError.isDSPError(error)) {
      request.log.error({ err: error, requestId }, 'unhandled request error')
    } else {
      request.log.warn({ code: error.code, requestId }, error.message)
    }

    const { status, body } = toResponse(error, requestId)
    void reply.status(status).send(body)
  })

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const requestId = String(request.id)
    void reply.status(404).send({
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: `No DSP endpoint matches ${request.method} ${request.url}`,
        retryable: false,
        requestId,
      },
    } satisfies DSPErrorResponse)
  })
}
