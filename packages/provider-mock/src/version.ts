import { createRequire } from 'node:module'

/**
 * The mock provider's reported version, read from package metadata so provider
 * discovery stays aligned with automated releases.
 */
const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

export const MOCK_PROVIDER_VERSION: string = pkg.version
