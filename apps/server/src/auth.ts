import { timingSafeEqual } from 'node:crypto'
import { DSPError, type Actor, type ActorType } from '@dsp/protocol'
import type { FastifyRequest } from 'fastify'

/** Discovery and health are readable without a token; everything else is not. */
const PUBLIC_PATHS = new Set(['/health', '/.well-known/dsp', '/openapi.json'])

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path.split('?')[0] ?? path)
}

export function assertAuthorized(request: FastifyRequest, expectedToken: string): void {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new DSPError('UNAUTHORIZED', 'A bearer token is required', {
      details: { scheme: 'bearer' },
    })
  }

  const provided = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new DSPError('UNAUTHORIZED', 'The bearer token is not valid')
  }
}

const ACTOR_TYPES: readonly ActorType[] = ['human', 'agent', 'system']

/**
 * The caller may describe itself through headers. This is attribution for the
 * audit log, never authorization: the bearer token decides what is allowed.
 */
export function actorFrom(request: FastifyRequest): Actor {
  const rawType = request.headers['x-dsp-actor-type']
  const rawId = request.headers['x-dsp-actor-id']

  const type =
    typeof rawType === 'string' && ACTOR_TYPES.includes(rawType as ActorType)
      ? (rawType as ActorType)
      : 'agent'

  const id =
    typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim().slice(0, 128) : 'anonymous'

  return { type, id }
}
