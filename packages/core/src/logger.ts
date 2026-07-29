import { redactSensitiveData } from '@dsp/protocol'
import type { Logger } from '@dsp/provider-sdk'
import { pino, type Logger as PinoLogger } from 'pino'

export interface LoggerOptions {
  level?: string
  pretty?: boolean
  base?: Record<string, unknown>
}

/**
 * Wraps pino so that every logged object passes through DSP redaction first.
 * Providers get this through `ProviderContext.logger`, which means a provider
 * cannot accidentally log a credential even if it tries.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const root = pino({
    level: options.level ?? process.env['DSP_LOG_LEVEL'] ?? 'info',
    base: options.base ?? {},
    redact: {
      paths: [
        'authorization',
        'headers.authorization',
        'headers.cookie',
        'req.headers.authorization',
        'req.headers.cookie',
        'secret',
        'secrets',
        'apiToken',
        'password',
        '*.authorization',
        '*.apiToken',
        '*.secret',
      ],
      censor: '[REDACTED]',
    },
    ...(options.pretty === true
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  })

  return wrap(root)
}

function wrap(logger: PinoLogger): Logger {
  const emit =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (fields: Record<string, unknown>, message: string): void => {
      logger[level](redactSensitiveData(fields) as Record<string, unknown>, message)
    }

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (fields) => wrap(logger.child(redactSensitiveData(fields) as Record<string, unknown>)),
  }
}
