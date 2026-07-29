import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MockBackend } from '../src/backend.js'
import { MockProvider } from '../src/provider.js'
import { MOCK_PROVIDER_VERSION } from '../src/version.js'

async function packageVersion(): Promise<string> {
  const path = fileURLToPath(new URL('../package.json', import.meta.url))
  const raw = await readFile(path, 'utf8')
  return (JSON.parse(raw) as { version: string }).version
}

describe('mock provider version', () => {
  it('comes from package metadata', async () => {
    const backend = new MockBackend(':memory:')

    try {
      const version = await packageVersion()

      expect(MOCK_PROVIDER_VERSION).toBe(version)
      expect(new MockProvider({ backend }).version).toBe(version)
    } finally {
      backend.close()
    }
  })

  it('is a semantic version', () => {
    expect(MOCK_PROVIDER_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  })
})
