# Contributing to DSP

## Prerequisites

- **Node.js 22 or newer.** DSP uses the built-in `node:sqlite`, so there is no
  native module to compile.
- **pnpm 10 or newer.** The repository is a pnpm workspace.

```bash
pnpm install
pnpm build
```

## Commands

All of these run from the repository root:

| Command             | What it does                                               |
| ------------------- | ---------------------------------------------------------- |
| `pnpm build`        | `tsc -b` across the whole workspace, in dependency order   |
| `pnpm typecheck`    | the same build, used as the typecheck gate                 |
| `pnpm test`         | the full Vitest suite                                      |
| `pnpm test:watch`   | Vitest in watch mode                                       |
| `pnpm lint`         | ESLint across the workspace                                |
| `pnpm lint:fix`     | ESLint with `--fix`                                        |
| `pnpm format`       | Prettier write                                             |
| `pnpm format:check` | Prettier check                                             |
| `pnpm verify`       | build, then lint, then test — run this before opening a PR |
| `pnpm dev:server`   | run the server from `dist` with `--watch`                  |

Tests resolve `@dsp/*` to package sources through aliases in `vitest.config.ts`, so
they do not need a build. Everything else does.

## Layout

```
apps/server            HTTP surface, OpenAPI description, env parsing
apps/cli               the `dsp` command line client
packages/protocol      types, canonical JSON, hashing, JSON Schemas, redaction
packages/plan-engine   normalization, diff, dependency graph, risk, plan assembly
packages/policy-engine declarative policy evaluation
packages/execution-engine  plan execution: retries, timeouts, cancellation
packages/verification-engine  desired versus observed comparison
packages/audit         hash-chained audit log
packages/secret-store  secret stores and scoped resolution
packages/provider-sdk  the provider contract and the conformance suite
packages/provider-mock the reference provider
packages/core          the runtime and its persistence
schemas/               the published JSON Schema contract (generated)
examples/              runnable Desired State documents and a policy bundle
docs/                  architecture, protocol, security, guides
```

Dependencies point one way: `protocol` depends on nothing internal, the engines
depend on `protocol`, `core` depends on the engines, and the apps depend on `core`.
A change that would create a cycle is a design problem, not a build problem.

## Code style

The project is functional by default and strict everywhere.

- Small pure functions with one responsibility. Classes only where identity or
  lifecycle genuinely exists (stores, the runtime, providers).
- Immutability. Return new values rather than mutating inputs.
- `async`/`await`, never `.then()` chains.
- Early returns instead of deep nesting.
- **No `any`.** Boundary code narrows `unknown` explicitly.
- `import type` for type-only imports (`verbatimModuleSyntax` is on).
- Relative imports carry the `.js` extension (`NodeNext` resolution).
- No `console.log` in library code. The CLI writes to stdout because that is its
  job; libraries take a `Logger`.
- Never swallow an error. An empty `catch` is a lint error.
- Comments explain **why**, not what. If a line needs a comment to say what it
  does, rename something instead.
- Errors are `DSPError` with a code from the published list, an accurate
  `retryable` flag, and details that never contain a secret.

## Tests

- A test name states the invariant it protects, not the function it calls.
- Prefer real components over mocks: the integration tests drive the real runtime
  over real SQLite (`:memory:`) with the real provider. Only the clock and the
  retry sleep are faked.
- Every new behaviour needs a test. Every fixed bug needs a test that would have
  caught it.
- Close stores in `afterEach`. A leaked connection makes the next test flaky.

## Adding a provider

Read [docs/provider-authoring.md](docs/provider-authoring.md) first.

A new provider **must** pass the conformance suite before it can be merged:

```ts
import { runProviderConformanceSuite } from '@dsp/provider-sdk/conformance'

runProviderConformanceSuite({
  name: 'my-provider',
  createProvider: () => new MyProvider({/* ... */}),
  validDocument: () => myDocument,
})
```

The suite is not a formality. It checks side-effect freedom, plan determinism,
apply idempotency, blocked deletions and secret containment — the properties the
whole protocol rests on.

A provider that talks to a real service must default to that service's test or
sandbox mode, and must fail loudly rather than quietly touching production.

## Changing the protocol

A change to the protocol surface must update, in the same pull request:

1. the TypeScript types in `packages/protocol/src`
2. `SPEC.md`, using RFC 2119 keywords
3. the published schemas, by running the generator:

```bash
node packages/protocol/dist/scripts/generate-schemas.js
```

A test fails if `schemas/*.json` drifts from the TypeScript source of truth, so a
forgotten regeneration will not reach `main`.

If the change alters what a plan hash covers, say so explicitly in the PR
description: it invalidates every stored plan and approval.

## Commits and changesets

Commit messages describe the change and its reason, imperatively:

```
Refuse to extend a plan's validity window on re-plan

Approvals are bound to the plan hash, so extending the window let an old
approval authorize a change indefinitely.
```

Any change to a published package needs a changeset:

```bash
pnpm changeset
```

Pre-1.0, a breaking protocol change is a minor bump and must be described as
breaking in the changeset.

## Pull requests

Before opening one:

```bash
pnpm verify
```

Describe what changed, why, and what you did to convince yourself it works. If you
found a bug while writing the change, say so — that is the most useful sentence in
the description.
