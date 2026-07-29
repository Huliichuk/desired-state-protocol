import { DSPError } from '@dsp/protocol'
import { z } from 'zod'

const desiredStateBody = z.object({
  desiredState: z.unknown(),
})

export const validateBodySchema = desiredStateBody
export const inspectBodySchema = desiredStateBody

export const planBodySchema = z.object({
  desiredState: z.unknown(),
  options: z
    .object({
      allowDelete: z.boolean().optional(),
      allowReplace: z.boolean().optional(),
      refreshCurrentState: z.boolean().optional(),
    })
    .optional(),
})

export const approveBodySchema = z.object({
  approvedBy: z.string().min(1).max(128),
  reason: z.string().min(1).max(1024),
  planHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
})

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  afterSequence: z.coerce.number().int().min(0).optional(),
  planId: z.string().optional(),
  operationId: z.string().optional(),
  action: z.string().optional(),
})

/**
 * Request bodies are the outer boundary of the runtime, so a bad body is a
 * client error with a precise path, never a 500.
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (result.success) return result.data

  throw new DSPError('VALIDATION_FAILED', 'Request body is not valid', {
    details: {
      errors: result.error.issues.map((issue) => ({
        code: 'INVALID_REQUEST_BODY',
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  })
}
