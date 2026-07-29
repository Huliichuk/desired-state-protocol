import { readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  DSPError,
  createSchemaValidator,
  policySchema,
  type PolicyBundle,
  type PolicyDocument,
} from '@dsp/protocol'
import { parse as parseYaml } from 'yaml'

const validator = createSchemaValidator(policySchema, { code: 'VALIDATION_FAILED' })

export function parsePolicyDocument(raw: unknown, source = '<inline>'): PolicyDocument {
  const result = validator.validate(raw)
  if (!result.valid) {
    throw new DSPError('VALIDATION_FAILED', `Invalid policy document in ${source}`, {
      details: { source, errors: result.errors },
    })
  }
  return raw as PolicyDocument
}

export function parsePolicyText(text: string, source = '<inline>'): PolicyDocument {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (error) {
    throw new DSPError(
      'VALIDATION_FAILED',
      `Policy document in ${source} is not valid YAML or JSON`,
      {
        cause: error,
        details: { source },
      },
    )
  }
  return parsePolicyDocument(parsed, source)
}

/**
 * Loads every `*.yaml`, `*.yml` and `*.json` policy in a directory.
 * A missing directory yields an empty bundle rather than an error, so a runtime
 * can start with no policies configured.
 */
export async function loadPolicyBundleFromDirectory(directory: string): Promise<PolicyBundle> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (isNotFound(error)) return { policies: [] }
    throw new DSPError('INTERNAL_ERROR', `Policy directory "${directory}" could not be read`, {
      cause: error,
    })
  }

  const files = entries
    .filter((entry) => ['.yaml', '.yml', '.json'].includes(extname(entry)))
    .sort()

  const policies: PolicyDocument[] = []
  for (const file of files) {
    const path = join(directory, file)
    policies.push(parsePolicyText(await readFile(path, 'utf8'), path))
  }

  assertUniqueNames(policies)
  return { policies }
}

export function assertUniqueNames(policies: readonly PolicyDocument[]): void {
  const seen = new Set<string>()
  for (const policy of policies) {
    if (seen.has(policy.metadata.name)) {
      throw new DSPError('VALIDATION_FAILED', `Duplicate policy name "${policy.metadata.name}"`, {
        details: { policy: policy.metadata.name },
      })
    }
    seen.add(policy.metadata.name)
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
