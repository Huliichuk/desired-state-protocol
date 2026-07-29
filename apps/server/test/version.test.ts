import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DSP_PROTOCOL_VERSION } from '@dsp/protocol'
import { DEFAULT_SERVER_INFO } from '@dsp/core'
import { SERVER_VERSION } from '../src/version.js'

async function packageVersion(url: string): Promise<string> {
  const raw = await readFile(fileURLToPath(new URL(url, import.meta.url)), 'utf8')
  return (JSON.parse(raw) as { version: string }).version
}

/**
 * `server.version` in the manifest is how a client identifies the build it is
 * talking to. These tests exist because it used to be a literal in two files,
 * which would have kept reporting 0.1.0 forever once releases started moving.
 */
describe('reported versions come from package metadata', () => {
  it('the server reports its own package version', async () => {
    expect(SERVER_VERSION).toBe(await packageVersion('../package.json'))
  })

  it('the runtime default reports the core package version', async () => {
    expect(DEFAULT_SERVER_INFO.version).toBe(
      await packageVersion('../../../packages/core/package.json'),
    )
  })

  it('every reported version is a semantic version', () => {
    for (const [label, value] of [
      ['server', SERVER_VERSION],
      ['core default', DEFAULT_SERVER_INFO.version],
      ['protocol', DSP_PROTOCOL_VERSION],
    ] as const) {
      expect(value, label).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
    }
  })

  it('keeps the protocol version independent of the package version', () => {
    // Deliberately not asserted equal. The protocol version changes only when the
    // wire format changes, while packages release on their own cadence; coupling
    // them would force a protocol bump for every bug fix.
    expect(DSP_PROTOCOL_VERSION).toBe('0.1.0')
  })
})
