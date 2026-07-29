---
'@dsp/secret-store': patch
---

Typecheck the test suite, and fix what that revealed.

Every package tsconfig built `src` only, so no test file had ever been typechecked —
vitest strips types without checking them. The first run found six real errors,
including one API defect: `EnvSecretStore.setSecret` and `deleteSecret` were declared
with no parameters, so a caller holding the concrete type could not call them the way
the `SecretStore` interface documents.

`pnpm typecheck:tests` is now part of `pnpm verify` and runs as a CI gate.
