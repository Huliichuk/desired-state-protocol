/**
 * Fake credentials used to test redaction.
 *
 * Every value is assembled at runtime from fragments so that no complete
 * credential-shaped literal ever appears in a source file. These strings are
 * entirely invented, but a scanner cannot tell that: a literal `sk_live_…` in a
 * public repository trips GitHub push protection and generates a false
 * leaked-key alert at the vendor. Assembling them keeps the tests honest — the
 * runtime value still matches the detection patterns — without the noise.
 */
const join = (...parts: string[]): string => parts.join('')

export const SYNTHETIC = {
  stripeLive: join('sk', '_', 'live', '_', '51H8xAbCdEfGhIjKlMnOpQr'),
  stripeTest: join('sk', '_', 'test', '_', '51H8xAbCdEfGhIjKlMnOpQr'),
  stripeRestricted: join('rk', '_', 'live', '_', '51H8xAbCdEfGhIjKlMnOpQr'),
  stripeWebhook: join('whsec', '_', 'AbCdEfGhIjKlMnOpQrStUv'),
  githubToken: join('ghp', '_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123'),
  slackToken: join('xoxb', '-', '1234567890', '-', 'abcdefghij'),
  awsAccessKeyId: join('AKIA', 'IOSFODNN7EXAMPLE'),
  jwt: join('eyJhbGciOi', '.', 'eyJzdWIiOj', '.', 'SflKxwRJSM'),
  pemPrivateKey: join(
    '-----BEGIN RSA PRIVATE KEY-----\n',
    'MIIBOgIBAAJBA\n',
    '-----END RSA PRIVATE KEY-----',
  ),
} as const

/** A distinctive token used to assert it never reaches an output surface. */
export const LEAK_CANARY = join('sk', '_', 'test', '_', 'leakcanary1234567890abcd')
