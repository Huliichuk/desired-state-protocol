import { createRequire } from 'node:module'

/**
 * The running CLI build's version, read from its package metadata so the
 * `dsp --version` output moves with automated releases.
 */
const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

export const CLI_VERSION: string = pkg.version
