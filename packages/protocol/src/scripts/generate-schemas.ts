import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_SCHEMAS } from '../schemas/index.js'

/**
 * Writes the published JSON Schema contract to `schemas/` in the repo root.
 * `packages/protocol/test/schemas.test.ts` fails if the committed files drift
 * away from the TypeScript source of truth.
 */
export function renderSchema(schema: unknown): string {
  return `${JSON.stringify(schema, null, 2)}\n`
}

export async function generateSchemas(outputDir: string): Promise<string[]> {
  await mkdir(outputDir, { recursive: true })
  const written: string[] = []
  for (const [fileName, schema] of Object.entries(PROTOCOL_SCHEMAS)) {
    const target = `${outputDir}/${fileName}`
    await writeFile(target, renderSchema(schema), 'utf8')
    written.push(target)
  }
  return written
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  const outputDir = fileURLToPath(new URL('../../../../schemas', import.meta.url))
  const written = await generateSchemas(outputDir)
  process.stdout.write(`${written.length} schema files written to ${outputDir}\n`)
}
