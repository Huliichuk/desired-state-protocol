import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildProgram } from '../src/program.js'
import { CLI_VERSION } from '../src/version.js'

async function packageVersion(): Promise<string> {
  const path = fileURLToPath(new URL('../package.json', import.meta.url))
  const raw = await readFile(path, 'utf8')
  return (JSON.parse(raw) as { version: string }).version
}

describe('CLI version', () => {
  it('comes from package metadata', async () => {
    const version = await packageVersion()

    expect(CLI_VERSION).toBe(version)
    expect(buildProgram().version()).toBe(version)
  })

  it('is a semantic version', () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  })
})
