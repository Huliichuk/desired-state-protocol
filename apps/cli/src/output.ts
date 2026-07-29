import { DSPError, redactSensitiveData } from '@dsp/protocol'
import { EXIT, exitCodeFor, type ExitCode } from './exit-codes.js'
import { bold, dim, red, yellow } from './style.js'

export interface OutputOptions {
  json: boolean
}

export function emit(options: OutputOptions, payload: unknown, human: () => string): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(redactSensitiveData(payload), null, 2)}\n`)
    return
  }
  process.stdout.write(human())
}

export function warn(message: string): void {
  process.stderr.write(`${yellow('warning')} ${message}\n`)
}

/**
 * Renders a failure the same way whether it came from the server, the network
 * or the CLI itself, and picks the exit code from the DSP error code.
 */
export function reportError(error: unknown, options: OutputOptions): ExitCode {
  if (DSPError.isDSPError(error)) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ error: error.toPayload() }, null, 2)}\n`)
    } else {
      process.stderr.write(`\n${bold(red('DSP ERROR'))} ${red(error.code)}\n\n  ${error.message}\n`)
      const details = error.details
      if (details !== undefined) {
        process.stderr.write(
          `\n${dim(indent(JSON.stringify(redactSensitiveData(details), null, 2), '  '))}\n`,
        )
      }
      process.stderr.write('\n')
    }
    return exitCodeFor(error.code)
  }

  const message = error instanceof Error ? error.message : String(error)
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ error: { code: 'INTERNAL_ERROR', message, retryable: false } }, null, 2)}\n`,
    )
  } else {
    process.stderr.write(`\n${bold(red('DSP ERROR'))}\n\n  ${message}\n\n`)
  }
  return EXIT.error
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}
