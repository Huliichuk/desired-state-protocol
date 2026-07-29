import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DSPError, type SecretReference } from '@dsp/protocol'
import { SecretValue, secretKey, type ResolvedSecret, type SecretStore } from './types.js'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const FILE_VERSION = 1

interface EncryptedEntry {
  iv: string
  tag: string
  ciphertext: string
  version: string
  updatedAt: string
}

interface StoreFile {
  version: number
  kdf: { algorithm: 'scrypt'; salt: string; N: number; r: number; p: number } | null
  secrets: Record<string, EncryptedEntry>
}

export interface EncryptedFileSecretStoreOptions {
  filePath: string
  /** 32-byte key as base64 or hex, or a passphrase that is stretched with scrypt. */
  masterKey: string
}

/**
 * AES-256-GCM secret store backed by a single local file.
 *
 * Ciphertext, IV and auth tag are stored per secret; the master key never
 * touches disk. A wrong key fails authentication rather than returning garbage.
 */
export class EncryptedFileSecretStore implements SecretStore {
  readonly #filePath: string
  readonly #rawMasterKey: string
  #cachedKey: Buffer | null = null
  #writeQueue: Promise<void> = Promise.resolve()

  constructor(options: EncryptedFileSecretStoreOptions) {
    if (options.masterKey.length === 0) {
      throw new DSPError(
        'SECRET_ACCESS_DENIED',
        'A master key is required for the encrypted secret store',
      )
    }
    this.#filePath = options.filePath
    this.#rawMasterKey = options.masterKey
  }

  async getSecret(reference: SecretReference): Promise<ResolvedSecret> {
    const file = await this.#read()
    const key = secretKey(reference)
    const entry = file.secrets[key]
    if (entry === undefined) {
      throw new DSPError('SECRET_NOT_FOUND', `Secret "${key}" is not configured`, {
        details: { secret: key },
      })
    }
    if (reference.version !== undefined && reference.version !== entry.version) {
      throw new DSPError(
        'SECRET_NOT_FOUND',
        `Secret "${key}" version "${reference.version}" is not available`,
        { details: { secret: key, availableVersion: entry.version } },
      )
    }

    const plaintext = this.#decrypt(entry, this.#deriveKey(file))
    return {
      reference,
      value: new SecretValue(plaintext),
      version: entry.version,
      updatedAt: entry.updatedAt,
    }
  }

  async setSecret(reference: SecretReference, value: string): Promise<void> {
    await this.#mutate((file) => {
      const key = secretKey(reference)
      const entry = this.#encrypt(value, this.#deriveKey(file))
      file.secrets[key] = entry
    })
  }

  async deleteSecret(reference: SecretReference): Promise<void> {
    await this.#mutate((file) => {
      delete file.secrets[secretKey(reference)]
    })
  }

  async listSecretNames(): Promise<string[]> {
    const file = await this.#read()
    return Object.keys(file.secrets).sort()
  }

  async #mutate(apply: (file: StoreFile) => void): Promise<void> {
    // Serialize writes so concurrent callers cannot clobber each other's file.
    const next = this.#writeQueue.then(async () => {
      const file = await this.#read()
      apply(file)
      await this.#write(file)
    })
    this.#writeQueue = next.catch(() => undefined)
    await next
  }

  async #read(): Promise<StoreFile> {
    try {
      const raw = await readFile(this.#filePath, 'utf8')
      const parsed = JSON.parse(raw) as StoreFile
      if (parsed.version !== FILE_VERSION) {
        throw new DSPError(
          'INTERNAL_ERROR',
          `Unsupported secret store file version ${String(parsed.version)}`,
        )
      }
      return parsed
    } catch (error) {
      if (isNotFound(error)) return this.#emptyFile()
      if (DSPError.isDSPError(error)) throw error
      throw new DSPError('INTERNAL_ERROR', 'Secret store file could not be read', { cause: error })
    }
  }

  async #write(file: StoreFile): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true })
    const temporary = `${this.#filePath}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporary, this.#filePath)
  }

  #emptyFile(): StoreFile {
    return {
      version: FILE_VERSION,
      kdf: {
        algorithm: 'scrypt',
        salt: randomBytes(16).toString('base64'),
        N: 16384,
        r: 8,
        p: 1,
      },
      secrets: {},
    }
  }

  #deriveKey(file: StoreFile): Buffer {
    if (this.#cachedKey !== null) return this.#cachedKey

    const direct = decodeFixedKey(this.#rawMasterKey)
    if (direct !== null) {
      this.#cachedKey = direct
      return direct
    }

    if (file.kdf === null) {
      throw new DSPError(
        'SECRET_ACCESS_DENIED',
        'Secret store has no KDF parameters and the master key is not a 32-byte key',
      )
    }
    const derived = scryptSync(
      this.#rawMasterKey,
      Buffer.from(file.kdf.salt, 'base64'),
      KEY_BYTES,
      {
        N: file.kdf.N,
        r: file.kdf.r,
        p: file.kdf.p,
      },
    )
    this.#cachedKey = derived
    return derived
  }

  #encrypt(plaintext: string, key: Buffer): EncryptedEntry {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      version: randomBytes(8).toString('hex'),
      updatedAt: new Date().toISOString(),
    }
  }

  #decrypt(entry: EncryptedEntry, key: Buffer): string {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(entry.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(entry.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')
    } catch (error) {
      throw new DSPError(
        'SECRET_ACCESS_DENIED',
        'Secret could not be decrypted with the configured master key',
        {
          cause: error,
        },
      )
    }
  }
}

function decodeFixedKey(value: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex')
  if (/^[A-Za-z0-9+/]{43}=$|^[A-Za-z0-9+/]{44}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64')
    return decoded.length === KEY_BYTES ? decoded : null
  }
  return null
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * Constant-time comparison helper exposed for tests that assert a rotated key
 * really produces different ciphertext.
 */
export function buffersEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
