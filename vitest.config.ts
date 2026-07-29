import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url))

const subpath = (pkg: string, entry: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/${entry}/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Subpath exports must come first: aliases are matched as prefixes, so the
      // bare package alias would otherwise swallow `@dsp/provider-sdk/conformance`.
      '@dsp/provider-sdk/conformance': subpath('provider-sdk', 'conformance'),
      '@dsp/protocol': src('protocol'),
      '@dsp/secret-store': src('secret-store'),
      '@dsp/provider-sdk': src('provider-sdk'),
      '@dsp/policy-engine': src('policy-engine'),
      '@dsp/plan-engine': src('plan-engine'),
      '@dsp/execution-engine': src('execution-engine'),
      '@dsp/verification-engine': src('verification-engine'),
      '@dsp/audit': src('audit'),
      '@dsp/provider-mock': src('provider-mock'),
      '@dsp/core': src('core'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
})
