import { DSPError } from '@dsp/protocol'
import { EncryptedFileSecretStore } from './encrypted-file-store.js'
import { EnvSecretStore } from './env-store.js'
import type { SecretStore } from './types.js'

export type SecretStoreKind = 'env' | 'encrypted-file'

export interface SecretStoreConfig {
  kind: SecretStoreKind
  /** Required for `encrypted-file`. */
  filePath?: string
  /** Required for `encrypted-file`. Never logged. */
  masterKey?: string
  /** Optional prefix override for `env`. */
  envPrefix?: string
}

export function createSecretStore(config: SecretStoreConfig): SecretStore {
  switch (config.kind) {
    case 'env':
      return new EnvSecretStore(config.envPrefix === undefined ? {} : { prefix: config.envPrefix })
    case 'encrypted-file': {
      if (config.filePath === undefined || config.masterKey === undefined) {
        throw new DSPError(
          'INTERNAL_ERROR',
          'The encrypted-file secret store requires both filePath and masterKey',
        )
      }
      return new EncryptedFileSecretStore({
        filePath: config.filePath,
        masterKey: config.masterKey,
      })
    }
  }
}
