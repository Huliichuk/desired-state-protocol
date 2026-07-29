import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DSPError } from '@dsp/protocol'
import {
  DenyAllSecretResolver,
  EncryptedFileSecretStore,
  EnvSecretStore,
  MemorySecretStore,
  ScopedSecretResolver,
  SecretValue,
  createSecretStore,
  secretKey,
  toEnvSegment,
} from '@dsp/secret-store'

/**
 * `rejects.toThrow(/x/)` matches the message, which would silently pass for the
 * wrong error. Assert on the DSP error code instead.
 */
async function expectRejectionCode(promise: Promise<unknown>, code: string): Promise<DSPError> {
  try {
    await promise
    expect.unreachable(`the call must reject with ${code}`)
  } catch (error) {
    if (!DSPError.isDSPError(error)) throw error
    expect(error.code).toBe(code)
    return error
  }
}

describe('SecretValue', () => {
  const value = new SecretValue('sk_test_plaintext_value')

  it('reveals the plaintext only through an explicit call', () => {
    expect(value.reveal()).toBe('sk_test_plaintext_value')
  })

  it('redacts itself on every accidental serialization path', () => {
    expect(String(value)).toBe('[REDACTED]')
    expect(`${value}`).toBe('[REDACTED]')
    expect(value.toJSON()).toBe('[REDACTED]')
    expect(JSON.stringify({ credential: value })).toBe('{"credential":"[REDACTED]"}')
  })

  it('exposes its length without exposing its content', () => {
    expect(value.length).toBe('sk_test_plaintext_value'.length)
  })
})

describe('secretKey', () => {
  it('distinguishes a whole secret from a key inside it', () => {
    expect(secretKey({ name: 'stripe' })).toBe('stripe')
    expect(secretKey({ name: 'stripe', key: 'apiKey' })).toBe('stripe/apiKey')
  })
})

describe('EnvSecretStore', () => {
  const env = {
    DSP_SECRET_STRIPE_TEST: 'sk_test_value',
    DSP_SECRET_STRIPE_TEST_API_KEY: 'sk_test_nested',
    DSP_SECRET_EMPTY: '',
  }
  const store = new EnvSecretStore({ env })

  it('maps a hyphenated name onto an upper-snake environment variable', () => {
    expect(toEnvSegment('stripe-test')).toBe('STRIPE_TEST')
    expect(toEnvSegment('stripe-test/apiKey')).toBe('STRIPE_TEST_API_KEY')
  })

  it('resolves a configured secret', async () => {
    const resolved = await store.getSecret({ name: 'stripe-test' })
    expect(resolved.value.reveal()).toBe('sk_test_value')
    expect(resolved.version).toBe('env')
  })

  it('resolves a key inside a secret', async () => {
    const resolved = await store.getSecret({ name: 'stripe-test', key: 'apiKey' })
    expect(resolved.value.reveal()).toBe('sk_test_nested')
  })

  it('names the expected variable when a secret is missing', async () => {
    try {
      await store.getSecret({ name: 'absent' })
      expect.unreachable('a missing secret must be reported')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('SECRET_NOT_FOUND')
      expect(error.details?.['expectedEnvVar']).toBe('DSP_SECRET_ABSENT')
    }
  })

  it('treats an empty variable as unset', async () => {
    await expect(store.getSecret({ name: 'empty' })).rejects.toThrow(
      /SECRET_NOT_FOUND|not configured/,
    )
  })

  it('is read-only, because mutating the process environment would be untraceable', async () => {
    await expect(store.setSecret({ name: 'x' }, 'v')).rejects.toThrow(/read-only/)
    await expect(store.deleteSecret({ name: 'x' })).rejects.toThrow(/read-only/)
  })

  it('lists the secret names it can serve', async () => {
    expect(await store.listSecretNames()).toContain('stripe-test')
  })

  it('honours a custom prefix', async () => {
    const custom = new EnvSecretStore({ prefix: 'APP_', env: { APP_TOKEN: 'v' } })
    expect((await custom.getSecret({ name: 'token' })).value.reveal()).toBe('v')
  })
})

describe('EncryptedFileSecretStore', () => {
  let directory: string
  let filePath: string
  const masterKey = randomBytes(32).toString('base64')

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsp-secrets-'))
    filePath = join(directory, 'nested', 'secrets.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const open = (key = masterKey): EncryptedFileSecretStore =>
    new EncryptedFileSecretStore({ filePath, masterKey: key })

  it('round-trips a secret through disk', async () => {
    const store = open()
    await store.setSecret({ name: 'stripe' }, 'sk_test_round_trip')
    expect((await store.getSecret({ name: 'stripe' })).value.reveal()).toBe('sk_test_round_trip')
  })

  it('survives a restart, so the key never has to live in the process', async () => {
    await open().setSecret({ name: 'stripe' }, 'sk_test_persisted')
    expect((await open().getSecret({ name: 'stripe' })).value.reveal()).toBe('sk_test_persisted')
  })

  it('writes neither the plaintext nor the master key to disk', async () => {
    await open().setSecret({ name: 'stripe' }, 'sk_test_on_disk_check')
    const onDisk = await readFile(filePath, 'utf8')
    expect(onDisk).not.toContain('sk_test_on_disk_check')
    expect(onDisk).not.toContain(masterKey)
    expect(onDisk).toContain('ciphertext')
  })

  it('fails authentication with the wrong master key instead of returning garbage', async () => {
    await open().setSecret({ name: 'stripe' }, 'sk_test_value')
    const wrong = open(randomBytes(32).toString('base64'))
    await expectRejectionCode(wrong.getSecret({ name: 'stripe' }), 'SECRET_ACCESS_DENIED')
  })

  it('detects tampering with the ciphertext', async () => {
    await open().setSecret({ name: 'stripe' }, 'sk_test_value')
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as {
      secrets: Record<string, { ciphertext: string }>
    }
    const entry = raw.secrets['stripe']
    if (entry === undefined) expect.unreachable('the secret must be on disk')
    else entry.ciphertext = Buffer.from('tampered').toString('base64')
    await rm(filePath)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, JSON.stringify(raw))

    await expectRejectionCode(open().getSecret({ name: 'stripe' }), 'SECRET_ACCESS_DENIED')
  })

  it('reports a missing secret rather than a decryption failure', async () => {
    await expect(open().getSecret({ name: 'absent' })).rejects.toThrow(/not configured/)
  })

  it('deletes a secret', async () => {
    const store = open()
    await store.setSecret({ name: 'stripe' }, 'v')
    await store.deleteSecret({ name: 'stripe' })
    expect(await store.listSecretNames()).toEqual([])
  })

  it('does not lose secrets written concurrently', async () => {
    const store = open()
    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        store.setSecret({ name: `secret-${index}` }, `value-${index}`),
      ),
    )
    expect(await store.listSecretNames()).toHaveLength(12)
    expect((await store.getSecret({ name: 'secret-7' })).value.reveal()).toBe('value-7')
  })

  it('produces different ciphertext for the same plaintext, because the IV is fresh', async () => {
    const store = open()
    await store.setSecret({ name: 'a' }, 'same-value')
    await store.setSecret({ name: 'b' }, 'same-value')
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as {
      secrets: Record<string, { ciphertext: string; iv: string }>
    }
    expect(raw.secrets['a']?.iv).not.toBe(raw.secrets['b']?.iv)
    expect(raw.secrets['a']?.ciphertext).not.toBe(raw.secrets['b']?.ciphertext)
  })

  it('accepts a hex master key and a passphrase stretched with scrypt', async () => {
    const hexStore = new EncryptedFileSecretStore({
      filePath: join(directory, 'hex.json'),
      masterKey: randomBytes(32).toString('hex'),
    })
    await hexStore.setSecret({ name: 'a' }, 'v')
    expect((await hexStore.getSecret({ name: 'a' })).value.reveal()).toBe('v')

    const phraseFile = join(directory, 'phrase.json')
    const phrase = new EncryptedFileSecretStore({
      filePath: phraseFile,
      masterKey: 'a long passphrase',
    })
    await phrase.setSecret({ name: 'a' }, 'v')
    const reopened = new EncryptedFileSecretStore({
      filePath: phraseFile,
      masterKey: 'a long passphrase',
    })
    expect((await reopened.getSecret({ name: 'a' })).value.reveal()).toBe('v')
  })

  it('refuses to start without a master key', () => {
    expect(() => new EncryptedFileSecretStore({ filePath, masterKey: '' })).toThrow(DSPError)
  })

  it('rejects a request for a version it does not hold', async () => {
    const store = open()
    await store.setSecret({ name: 'stripe' }, 'v')
    await expect(store.getSecret({ name: 'stripe', version: 'nope' })).rejects.toThrow(
      /version "nope"/,
    )
  })
})

describe('MemorySecretStore', () => {
  it('serves seeded secrets and increments the version on overwrite', async () => {
    const store = new MemorySecretStore({ stripe: 'v1' })
    expect((await store.getSecret({ name: 'stripe' })).version).toBe('1')
    await store.setSecret({ name: 'stripe' }, 'v2')
    const resolved = await store.getSecret({ name: 'stripe' })
    expect(resolved.value.reveal()).toBe('v2')
    expect(resolved.version).toBe('2')
  })

  it('reports a missing secret', async () => {
    await expect(new MemorySecretStore().getSecret({ name: 'x' })).rejects.toThrow(/not configured/)
  })
})

describe('ScopedSecretResolver', () => {
  const store = new MemorySecretStore({
    allowed: 'sk_test_allowed',
    forbidden: 'sk_test_forbidden',
  })

  it('resolves only what the document declared', async () => {
    const resolver = new ScopedSecretResolver(store, [{ name: 'allowed' }])
    expect((await resolver.resolve({ name: 'allowed' })).value.reveal()).toBe('sk_test_allowed')
  })

  it('refuses a secret that exists but was not declared', async () => {
    const resolver = new ScopedSecretResolver(store, [{ name: 'allowed' }])
    try {
      await resolver.resolve({ name: 'forbidden' })
      expect.unreachable('an undeclared secret must not be readable')
    } catch (error) {
      if (!DSPError.isDSPError(error)) throw error
      expect(error.code).toBe('SECRET_ACCESS_DENIED')
      expect(error.message).toContain('not declared')
    }
  })

  it('scopes by the full key, not just the secret name', async () => {
    const resolver = new ScopedSecretResolver(store, [{ name: 'allowed', key: 'sub' }])
    await expectRejectionCode(resolver.resolve({ name: 'allowed' }), 'SECRET_ACCESS_DENIED')
  })

  it('records what it revealed so the runtime can scrub it from output', async () => {
    const resolver = new ScopedSecretResolver(store, [{ name: 'allowed' }])
    expect(resolver.revealedValues()).toEqual([])
    await resolver.resolve({ name: 'allowed' })
    expect(resolver.revealedValues()).toEqual(['sk_test_allowed'])
  })

  it('reports the references it is allowed to serve', () => {
    const resolver = new ScopedSecretResolver(store, [{ name: 'allowed' }])
    expect(resolver.allowedReferences()).toEqual([{ name: 'allowed' }])
  })

  it('notifies the runtime on each resolution so it can be audited', async () => {
    const seen: string[] = []
    const resolver = new ScopedSecretResolver(store, [{ name: 'allowed' }], (reference) =>
      seen.push(reference.name),
    )
    await resolver.resolve({ name: 'allowed' })
    expect(seen).toEqual(['allowed'])
  })

  it('does not notify when access was denied', async () => {
    const seen: string[] = []
    const resolver = new ScopedSecretResolver(store, [], (reference) => seen.push(reference.name))
    await expect(resolver.resolve({ name: 'allowed' })).rejects.toThrow()
    expect(seen).toEqual([])
  })
})

describe('DenyAllSecretResolver', () => {
  it('denies everything and admits to holding nothing', async () => {
    const resolver = new DenyAllSecretResolver()
    await expectRejectionCode(resolver.resolve({ name: 'anything' }), 'SECRET_ACCESS_DENIED')
    expect(resolver.allowedReferences()).toEqual([])
    expect(resolver.revealedValues()).toEqual([])
  })
})

describe('createSecretStore', () => {
  it('builds an environment store', async () => {
    expect(createSecretStore({ kind: 'env' })).toBeInstanceOf(EnvSecretStore)
  })

  it('builds an encrypted file store', () => {
    const store = createSecretStore({
      kind: 'encrypted-file',
      filePath: join(tmpdir(), 'dsp-factory-secrets.json'),
      masterKey: randomBytes(32).toString('base64'),
    })
    expect(store).toBeInstanceOf(EncryptedFileSecretStore)
  })

  it('refuses an encrypted file store without a path or key', () => {
    expect(() => createSecretStore({ kind: 'encrypted-file' })).toThrow(/requires both/)
  })
})
