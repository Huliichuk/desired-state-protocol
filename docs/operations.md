# Operating a DSP runtime

Running, configuring and debugging the reference runtime. For the security posture
behind these settings, see [security.md](security.md).

## Environment reference

Every variable read by [`apps/server/src/env.ts`](../apps/server/src/env.ts). A
copy-and-edit version lives in [`.env.example`](../.env.example).

| Variable                  | Default               | Effect                                                                   |
| ------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `DSP_HOST`                | `127.0.0.1`           | Interface to bind. `0.0.0.0` only behind a TLS terminator.               |
| `DSP_PORT`                | `4040`                | Port. Must be a positive integer or startup fails.                       |
| `DSP_AUTH_TOKEN`          | _generated_           | Bearer token. Unset means a random per-process token, printed to stdout. |
| `DSP_ENVIRONMENT`         | `local`               | Feeds risk scoring and policy scope. The only source of environment.     |
| `DSP_TENANT`              | `local`               | Idempotency scope.                                                       |
| `DSP_POLICY_DIR`          | _built-in bundle_     | Directory of policy documents.                                           |
| `DSP_ALLOW_DESTRUCTIVE`   | `false`               | Whether deletions and replacements may execute at all.                   |
| `DSP_DATABASE`            | `.dsp/runtime.sqlite` | Plans, approvals, operations, idempotency, audit chain.                  |
| `DSP_MOCK_DATABASE`       | `.dsp/mock.sqlite`    | The mock provider's stand-in external system.                            |
| `DSP_SECRET_STORE`        | `env`                 | `env` or `encrypted-file`. Anything else fails at startup.               |
| `DSP_SECRET_FILE`         | `.dsp/secrets.json`   | Encrypted store path. Required for `encrypted-file`.                     |
| `DSP_SECRET_MASTER_KEY`   | —                     | Required for `encrypted-file`. 32-byte key or a passphrase.              |
| `DSP_MAX_DOCUMENT_BYTES`  | `524288`              | Document size limit.                                                     |
| `DSP_PLAN_TTL_SECONDS`    | `900`                 | Plan validity window.                                                    |
| `DSP_PROVIDER_TIMEOUT_MS` | `30000`               | Per-provider-call timeout.                                               |
| `DSP_LOG_LEVEL`           | `info`                | pino level, through `silent`.                                            |
| `DSP_LOG_PRETTY`          | `false`               | Human-readable logs via pino-pretty.                                     |

The CLI reads `DSP_SERVER` and `DSP_TOKEN` as defaults for `--server` and `--token`.

Booleans accept `1`, `true`, `yes`, `on`. Anything else is false.

## Starting a runtime

```bash
pnpm install
pnpm build
node apps/server/dist/main.js
```

With no `DSP_AUTH_TOKEN`, the server prints a token for that process:

```
No DSP_AUTH_TOKEN was set. Generated a token for this process only:

  kJ8x...redacted...

Use it as:  dsp --server http://127.0.0.1:4040 --token kJ8x... discover
```

That is a development convenience. In any deployment, set the token explicitly:

```bash
export DSP_AUTH_TOKEN=$(openssl rand -base64 32)
```

The server logs its effective configuration once at startup — environment, tenant,
loaded policy names, the policy bundle hash, and whether destructive changes are
enabled. Check that line after any config change; the policy bundle hash is the
quickest way to confirm the runtime loaded the bundle you think it did.

`SIGINT` and `SIGTERM` close the HTTP server and both databases. Repeated signals are
safe — `close()` is idempotent.

## Secrets

### Environment store (default)

Read-only. A document referencing `secretRef: { name: stripe-test }` reads
`DSP_SECRET_STRIPE_TEST`; adding `key: apiKey` reads
`DSP_SECRET_STRIPE_TEST_API_KEY`. Names are upper-snake-cased, and camelCase keys are
split: `apiKey` becomes `API_KEY`.

The runtime never mutates the process environment, so `setSecret` and `deleteSecret`
fail with `UNSUPPORTED_OPERATION`. That is deliberate: a secret store you can write
to at runtime is a secret store whose contents nobody can audit.

### Encrypted file store

AES-256-GCM, one IV and auth tag per secret, master key from the environment.

```bash
export DSP_SECRET_STORE=encrypted-file
export DSP_SECRET_FILE=.dsp/secrets.json
export DSP_SECRET_MASTER_KEY=$(openssl rand -base64 32)
```

The master key may be a 32-byte value in base64 or hex, or a passphrase, which is
stretched with scrypt using a salt stored in the file. The key itself never touches
disk. A wrong key fails authentication rather than returning plausible garbage, and
tampering with the ciphertext fails the same way.

Rotating the master key means re-encrypting: read every secret with the old key,
write it back with the new one. There is no in-place rotation in 0.1.

## Policies

```bash
DSP_POLICY_DIR=examples/mock-workspace/policies node apps/server/dist/main.js
```

`*.yaml`, `*.yml` and `*.json` are loaded, sorted by filename. A malformed policy is
a startup failure, not a skipped file, and two policies with the same
`metadata.name` are rejected.

Without `DSP_POLICY_DIR` the runtime uses its built-in bundle: deletions and
replacements denied, approval required for high and critical risk, a warning on
medium risk, and a cap of 100 changes per plan.

**Changing the bundle invalidates every stored plan.** The bundle hash is part of the
plan hash, so an existing plan applied under a new bundle fails with `POLICY_DENIED`
and the message _"the policy bundle changed after this plan was created"_. Expect
in-flight plans to need re-planning after a policy deploy.

## Storage

Two SQLite files, both created with their parent directories.

`DSP_DATABASE` holds `plans`, `approvals`, `operations`, `idempotency` and
`audit_events`. **This is the audit trail — back it up.** WAL mode is on, so a backup
must include the `-wal` and `-shm` sidecars, or be taken with `sqlite3 .backup`.

`DSP_MOCK_DATABASE` is the mock provider's fake external system. Deleting it is
equivalent to deleting the SaaS account: the next plan will want to create
everything again.

Inspecting the runtime database directly:

```bash
sqlite3 .dsp/runtime.sqlite "SELECT plan_id, plan_hash, expires_at FROM plans ORDER BY created_at DESC LIMIT 5;"
```

```bash
sqlite3 .dsp/runtime.sqlite "SELECT operation_id, status, updated_at FROM operations ORDER BY created_at DESC LIMIT 5;"
```

Editing rows by hand is detectable and will be detected: plans fail hash
recomputation, audit events fail chain verification.

## The audit chain

```bash
node apps/cli/dist/main.js audit verify
```

```
DSP AUDIT VERIFY

  ✓ chain intact across 29 event(s)
```

Run this on a schedule, not only during deploys. A broken chain names the first bad
event:

```json
{
  "valid": false,
  "events": 29,
  "brokenAt": {
    "sequence": 7,
    "eventId": "evt_...",
    "reason": "eventHash does not match the event contents"
  }
}
```

Treat a break as a security event. It means stored history was modified — by an
edit, a partial restore, or corruption. The chain is tamper-**evident**: it detects
modification, it does not prevent it, and an attacker who controls the process can
rewrite it consistently.

Browsing history:

```bash
node apps/cli/dist/main.js audit --limit 20
node apps/cli/dist/main.js audit --plan plan_08467877ad57796bf641fddd
node apps/cli/dist/main.js audit --operation op_a39cd0afa1acd056b00080f9
```

## Logs

pino JSON on stdout. `DSP_LOG_PRETTY=true` for local reading.

Logs are redacted twice: pino's own `redact` paths, and DSP redaction applied to
every logged object — by key name and by value shape. A provider that logs through
`context.logger` cannot leak a credential even by accident. A provider that reaches
for `console.log` can, which is why that is a lint error.

Request logging is on by default; use `DSP_LOG_LEVEL=warn` to quieten it while
keeping failures.

## CLI exit codes

From [`apps/cli/src/exit-codes.ts`](../apps/cli/src/exit-codes.ts). Stable, so a
pipeline can branch on them without parsing output.

| Code | Name             | Meaning                                                             |
| ---- | ---------------- | ------------------------------------------------------------------- |
| `0`  | ok               | Success.                                                            |
| `1`  | error            | Anything not covered below.                                         |
| `2`  | invalidDocument  | Validation, schema, immutable field, unknown kind or resource type. |
| `3`  | approvalRequired | Approval missing or invalid for this plan hash.                     |
| `4`  | policyDenied     | Policy denied, or a destructive action was blocked.                 |
| `5`  | stateDrift       | The world changed after the plan was created.                       |
| `6`  | notSatisfied     | The desired state does not hold.                                    |
| `7`  | planExpired      | The plan is past its window.                                        |
| `8`  | notConfirmed     | `apply` without `--confirm`. Nothing was applied.                   |
| `9`  | auditChainBroken | `audit verify` found a break.                                       |

`dsp plan` returns `4` when the plan is not executable, and `dsp apply` returns `6`
for both `partially_completed` and `verification_failed` — in both cases the desired
state is not true.

## Docker

```bash
export DSP_AUTH_TOKEN=$(openssl rand -base64 32)
docker compose up --build
```

```bash
curl -s localhost:4040/health
```

The image runs as the `node` user, keeps SQLite files in the `/data` volume, and has
a `HEALTHCHECK` against `/health`. `DSP_AUTH_TOKEN` is required by the compose file —
a container whose token is printed to its own stdout is not usable.

To mount a reviewed policy bundle, uncomment both the volume and `DSP_POLICY_DIR` in
[`docker-compose.yml`](../docker-compose.yml).

The image ships plain HTTP. Put a TLS terminator in front of it before exposing it.

## Runbook

### `APPROVAL_REQUIRED`

Policy wants a human. `details.requirements` says which rule and how many approvals.

```bash
node apps/cli/dist/main.js show <plan-id>
node apps/cli/dist/main.js approve <plan-id> --by "$USER" --reason "Reviewed plan"
node apps/cli/dist/main.js apply <plan-id> --confirm
```

Approve the hash you actually read. If `approve` returns `APPROVAL_INVALID`, the plan
changed since you looked — re-read it, do not re-send the old hash.

If `minApprovals` is greater than one, distinct people must approve; the same person
approving twice still counts once.

### `STATE_DRIFT_DETECTED`

Something changed between plan and apply. `details` carries `expectedRevision` and
`actualRevision`.

**Do not retry the old plan.** Re-plan:

```bash
node apps/cli/dist/main.js plan --file desired-state.yaml
```

The new plan shows what is now different. If it is empty, someone already made the
change you wanted. If drift keeps recurring, something else is writing to the same
resources — find it before applying again.

This also appears when re-applying an already-applied plan with a _different_
idempotency key. That is correct: the same key returns the original operation, a
different key is a new request against a world that has moved.

### `PLAN_EXPIRED`

The window closed. Re-plan. Note that any approval from the old window no longer
counts, by design — a re-plan does not revive a stale human decision.

Raise `DSP_PLAN_TTL_SECONDS` if review genuinely takes longer than the window, but
remember it is also the freshness bound on approvals.

### `POLICY_DENIED`

Two distinct causes, distinguished by the message:

- _"the policy bundle changed after this plan was created"_ — re-plan.
- otherwise the bundle denies this change. `details.denials` names the policy and
  rule. Either the document is wrong or the policy is; do not work around it by
  loosening `DSP_ALLOW_DESTRUCTIVE`.

### `PROVIDER_TIMEOUT`

A provider call exceeded `DSP_PROVIDER_TIMEOUT_MS`. The runtime already retried
internally with exponential backoff, so seeing this means every attempt timed out.

Check the external system's health first. Raise the timeout only if the operation is
genuinely slow rather than stuck — the timeout exists so a hung call cannot hold an
operation open indefinitely.

### A `partially_completed` operation

Some changes succeeded, some did not. Succeeded changes are **not** rolled back;
there is no compensation in 0.1.

```bash
node apps/cli/dist/main.js status <operation-id>
```

Read the per-change records:

- `failed` — `error.code` says why; `attempts` says how hard the runtime tried
- `blocked` — refused before execution, usually destructive or unsupported
- `skipped` with an error — a dependency did not succeed, so it was never attempted

Recovery is to re-plan. The new plan contains only the work still missing, so
re-applying is safe and converges rather than duplicating.

### `verification_failed`

Every change reported success, but re-reading the world disagreed. This is the case
worth taking seriously: it means a provider's success report is not trustworthy for
those fields.

`verification.unmatched` lists each path with expected and actual values, redacted
where the resource type declared the field sensitive. Common causes: the external
system normalized a value, applied a default the projection does not model, or
another actor changed it immediately afterwards.

### The server will not start

| Message                                                                  | Cause                                              |
| ------------------------------------------------------------------------ | -------------------------------------------------- |
| `DSP_PORT must be a positive integer`                                    | non-numeric port                                   |
| `DSP_SECRET_STORE must be "env" or "encrypted-file"`                     | typo in the store kind                             |
| `DSP_SECRET_MASTER_KEY is required when DSP_SECRET_STORE=encrypted-file` | missing key                                        |
| `Invalid policy document in <path>`                                      | a malformed policy; the details list schema errors |
| `Duplicate policy name "<name>"`                                         | two policies share `metadata.name`                 |
| `Kind "<kind>" is registered by more than one provider`                  | two providers claim the same kind                  |

All of these are deliberate startup failures. A runtime that cannot tell what its
own policy is should not accept requests.
