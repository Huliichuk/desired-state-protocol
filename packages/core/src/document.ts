import { readFile } from 'node:fs/promises'
import { DSPError } from '@dsp/protocol'
import { parse as parseYaml } from 'yaml'

/**
 * Parses a Desired State document from YAML or JSON text. The result is
 * deliberately typed `unknown`: it is untrusted input until the runtime has
 * validated it against the envelope and the kind's schema.
 */
export function parseDocumentText(text: string, source = '<inline>'): unknown {
  try {
    return parseYaml(text)
  } catch (error) {
    throw new DSPError('VALIDATION_FAILED', `${source} is not valid YAML or JSON`, {
      cause: error,
      details: { source },
    })
  }
}

export async function readDocumentFile(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new DSPError('VALIDATION_FAILED', `Desired State file "${path}" could not be read`, {
      cause: error,
      details: { path },
    })
  }
  return parseDocumentText(text, path)
}
