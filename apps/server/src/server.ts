import { requestId } from '@dsp/protocol'
import type { DSPRuntime } from '@dsp/core'
import Fastify, { type FastifyInstance } from 'fastify'
import { assertAuthorized, isPublicPath } from './auth.js'
import { registerErrorHandler } from './http-errors.js'
import { registerRoutes } from './routes.js'

export interface DspServerOptions {
  runtime: DSPRuntime
  /** Bearer token required on every non-public route. */
  authToken: string
  logLevel?: string
  pretty?: boolean
}

/**
 * Builds the DSP HTTP surface. Returned unstarted so tests can drive it with
 * `app.inject()` and never bind a port.
 */
export async function createServer(options: DspServerOptions): Promise<FastifyInstance> {
  const limits = options.runtime.config().limits

  const app = Fastify({
    genReqId: () => requestId(),
    // Reject oversized bodies at the transport layer, before any parsing.
    bodyLimit: limits.maxDocumentBytes + 64 * 1024,
    logger: {
      level: options.logLevel ?? process.env['DSP_LOG_LEVEL'] ?? 'info',
      ...(options.pretty === true
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["idempotency-key"]',
        ],
        censor: '[REDACTED]',
      },
    },
  })

  app.addHook('onRequest', async (request) => {
    if (isPublicPath(request.url)) return
    assertAuthorized(request, options.authToken)
  })

  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    reply.header('x-dsp-protocol-version', options.runtime.manifest().protocolVersion)
  })

  registerErrorHandler(app)
  await registerRoutes(app, { runtime: options.runtime })
  await app.ready()

  return app
}
