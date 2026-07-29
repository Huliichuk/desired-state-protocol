import { createRequire } from 'node:module'

/**
 * The running build's version, read from this package rather than written down a
 * second time.
 *
 * It is reported as `server.version` in the DSP manifest, which is how a client
 * identifies what it is talking to. A hardcoded string here would keep claiming
 * the version it was written at, so the one place it can drift from reality is
 * removed.
 */
const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { name: string; version: string }

export const SERVER_NAME = 'DSP Reference Runtime'
export const SERVER_VERSION: string = pkg.version
