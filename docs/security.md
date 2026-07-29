# DSP security model

This document describes what DSP 0.1 actually enforces, where in the code it is
enforced, and what it does not protect against. For how to report a vulnerability,
see [SECURITY.md](../SECURITY.md).

## Trust boundaries

```
┌──────────────┐   untrusted input    ┌──────────────────────┐   credentials   ┌───────────────┐
│  AI agent    │ ───────────────────► │    DSP runtime       │ ──────────────► │ external SaaS │
│  or client   │   documents, plan    │    (trusted)         │   least priv.   │ (blast radius)│
└──────────────┘   ids, approvals     └──────────┬───────────┘                 └───────────────┘
                                                 │ scoped secret resolver
                                                 ▼
                                        ┌──────────────────┐
                                        │ provider adapter │  semi-trusted code
                                        └──────────────────┘
```

- **The agent is untrusted input.** Everything it sends is data to be validated, not
  instructions to be followed.
- **The runtime is the trusted component.** It holds credentials, computes the plan,
  and decides what may run.
- **Providers are semi-trusted code.** They run in-process, so they are not a
  sandbox boundary — but they are constrained: scoped secrets, no ordering
  authority, and a refinement hook that cannot widen a plan.
- **The external system is the blast radius.** Everything else exists to bound it.

## Prompt-injection resistance

Natural language is never executed. The only thing that can cause an external
change is a plan id whose plan:

1. came from a document that passed `desired-state.schema.json` and the kind's spec
   schema and the provider's semantic validation
2. produced a change set computed by code, not by a model
3. satisfied the policy bundle
4. still hashes to the value stored with it
5. has not expired
6. has whatever approvals policy demanded, given for that exact hash and window
7. describes a world whose revision has not moved

`apply` takes a plan id and nothing else — see `ApplyInput` in
[`packages/core/src/runtime.ts`](../packages/core/src/runtime.ts). There is no
parameter through which a document can be smuggled in at apply time. This is the
control that makes the rest meaningful: even if an injected instruction convinces
an agent to attempt something, the attempt has to survive planning, policy and human
review before anything happens, and by then it is visible in a diff.

A corollary that is easy to miss: **the plan is what gets reviewed, so the plan must
be honest**. That is why the plan hash covers the real attribute values (§12.1 of
the spec) rather than the redacted ones a reviewer sees.

## Credential isolation

Three mechanisms, layered.

**Documents carry references, not values.** A Desired State document names a secret:

```yaml
credentials:
  secretRef:
    name: stripe-production
```

**Providers get a scoped resolver, never the store.** The runtime asks the provider
which secrets this document needs, then builds a resolver limited to exactly that
list — `#resolverFor` in
[`packages/core/src/runtime.ts`](../packages/core/src/runtime.ts), backed by
`ScopedSecretResolver` in
[`packages/secret-store/src/resolver.ts`](../packages/secret-store/src/resolver.ts).
A provider that asks for a secret it did not declare gets
`SECRET_ACCESS_DENIED`, even when that secret exists. A provider cannot enumerate
the store.

**Resolved values resist accidental disclosure.** `SecretValue`
([`packages/secret-store/src/types.ts`](../packages/secret-store/src/types.ts))
holds the plaintext in a private field and returns `[REDACTED]` from `toString()`,
`toJSON()`, template interpolation and `util.inspect`. Reaching the plaintext takes
an explicit `.reveal()`, which is greppable.

At rest, `EncryptedFileSecretStore` uses AES-256-GCM with a per-secret IV and auth
tag; the master key comes from the environment and never touches disk. A wrong key
fails authentication rather than returning plausible garbage.

## Redaction

`redactSensitiveData` in
[`packages/protocol/src/redaction.ts`](../packages/protocol/src/redaction.ts)
removes three classes of data:

- values under sensitive **key names** (`authorization`, `cookie`, `apiToken`,
  `password`, `secret`, `token`, `privateKey`, `clientSecret`, …)
- values matching secret **shapes** regardless of key: Stripe `sk_`/`rk_`/`whsec_`,
  GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, Slack `xox*`, AWS `AKIA…`, JWTs, PEM
  private key blocks, `Bearer <token>`
- values at **paths a resource type declared** in `sensitiveFields`

Redaction is deliberately aggressive. A false positive costs readability; a false
negative leaks a credential.

It is applied at every boundary that leaves the runtime:

| Boundary                | Where                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| Plan responses          | `redactPlanForOutput`, called by `DSPRuntime.plan` and `getPlan`     |
| Inspected state         | `redactCurrentStateForOutput`                                        |
| Verification mismatches | sensitive paths become `[REDACTED]` in expected/actual               |
| Audit metadata          | `AuditLog.record` redacts before hashing                             |
| Logs                    | `createLogger` redacts every logged object, plus pino `redact` paths |
| HTTP errors             | `toErrorPayload` never forwards a non-DSP error's message            |
| CLI output              | `emit` and `reportError` redact before printing                      |

### A deliberate asymmetry

The **stored** plan keeps real values. Apply needs them, and the plan hash has to
cover actual intent — otherwise two different changes could hash the same.

The consequence is explicit: **a client cannot recompute the plan hash from the
redacted plan it received.** A client verifies by plan id and by the hash the server
echoes, not by re-hashing. If you need reviewers to check hashes independently, keep
credentials out of resource attributes entirely and use `secretRef`. The mock
provider emits an `INLINE_SECRET` warning for exactly this reason.

## Destructive actions

`delete` and `replace` are refused by default, and this cannot be relaxed per
request. `PlanOptions.allowDelete` is intersected with the runtime's
`allowDestructive` configuration; asking for deletions on a runtime that forbids
them fails with `DESTRUCTIVE_ACTION_BLOCKED` at plan time rather than being quietly
ignored.

There are two independent gates, and both must open:

1. the runtime must be configured with `allowDestructive`
2. the resource type must declare `capabilities.delete: true`

A blocked change is still shown in the plan, with `before` intact and
`blockedBy` set, so a reviewer can see what _would_ have been destroyed. It is
recorded as `blocked` in the operation and never executed, and verification then
reports the desired state as unmet — the runtime does not pretend a refusal was a
success.

## Privilege and scope confusion

**Environment comes from configuration, never from the document.** A document that
could set its own environment could pick the weakest policy. `#policyContext`
reads only `RuntimeConfig.environment`; `metadata.labels` are inert.

**Actor headers are attribution, not authorization.** `X-DSP-Actor-Type` and
`X-DSP-Actor-Id` are recorded in the audit log and consulted nowhere else. The
bearer token decides what is permitted.

**Provider refinement cannot widen a plan.** `assertRefinement` in
[`packages/plan-engine/src/build-plan.ts`](../packages/plan-engine/src/build-plan.ts)
rejects a refinement that changes the number of changes, their order, or any of
`id`, `action`, `resourceType`, `resourceKey`, `dependencies`, `before`, `after`.
A provider may annotate; it may not add work.

## Drift and time-of-check/time-of-use

A plan records the revision it observed. Before executing, the runtime re-reads the
revision and refuses on any difference with `STATE_DRIFT_DETECTED`, reporting both
values. A client may additionally pin the revision it believes in with `If-Match`.

A stale plan is never applied automatically. The narrowing is not eliminated —
something can still change between the drift check and the first write — but the
window shrinks from "however long review took" to "one round trip", and the
provider's own idempotency covers the remainder.

**Approvals are bound to a window as well as a hash.** Because a plan id is derived
from the plan hash, re-planning an unchanged world lands on the existing plan. If
re-planning could push `expiresAt` forward, an agent could keep a months-old human
approval alive indefinitely by re-planning in a loop. So re-planning an unexpired
plan preserves its window, and an approval recorded before the current window
opened does not count.

## Tamper evidence

Two hash-based mechanisms:

**Plan hashes.** Recomputed before every apply. Editing a stored plan — in the
database, in a backup, in transit — produces `PLAN_HASH_MISMATCH`.

**The audit chain.** Each event's hash covers its own contents and its
predecessor's hash, so modifying or reordering any past event breaks every hash
from that point on. `dsp audit verify` reports the first broken event.

Both are **tamper-evident, not tamper-proof.** An attacker who controls the runtime
process can write whatever history they like and it will verify, because they can
recompute the chain. This is a local integrity check against database edits,
backup corruption and accidental rewriting — not a distributed ledger, and not a
blockchain. Detecting a compromised runtime requires shipping events to a store the
runtime cannot rewrite; that is v0.2 work.

## Resource limits and denial of service

| Limit                    | Default | Enforced by                                                               |
| ------------------------ | ------- | ------------------------------------------------------------------------- |
| Document size            | 512 KiB | `assertDocumentLimits`, plus Fastify's `bodyLimit` at the transport layer |
| JSON nesting depth       | 32      | `assertDocumentLimits`                                                    |
| Canonicalization depth   | 100     | `canonicalize`, so hashing cannot be made to recurse without bound        |
| Resources per projection | 500     | `#assertResourceLimits`                                                   |
| Changes per plan         | 1000    | `assertChangeLimit`                                                       |
| Provider call duration   | 30 s    | `AbortSignal.timeout` per attempt                                         |
| Plan TTL                 | 900 s   | plan expiry                                                               |

Fastify rejects an oversized body before any parsing happens, so a large payload
does not get canonicalized first.

Policies can add a further bound: `maxTotalChanges` in the shipped baseline caps a
single apply at 100 changes, so one document cannot rewrite an entire account.

## SSRF

A provider **must not** dereference a URL taken from a Desired State document. The
mock provider makes no network calls at all, so 0.1 has no exposure.

A future HTTP-backed provider must:

- derive its base URL from runtime configuration or a resolved secret, never from
  the document
- treat document fields as path segments or query values only after escaping, never
  as hosts
- keep an allow-list of hosts it will contact
- refuse redirects to a host outside that list
- refuse link-local, loopback and metadata addresses

## Known gaps in 0.1

Stated plainly, because a security document that only lists strengths is marketing.

| Gap                                             | Consequence                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Single tenant                                   | `tenant` is the constant `local`; there is no isolation between callers.                                   |
| Bearer tokens only                              | One token grants the whole API. No scopes, no per-caller identity, no OAuth, no workload identity.         |
| No TLS                                          | The server speaks plain HTTP; terminate TLS in front of it.                                                |
| No signed provider manifests                    | A provider is trusted because it was compiled in, not because it was verified.                             |
| No compensation or rollback                     | A `partially_completed` operation leaves the succeeded changes in place. Re-planning is the recovery path. |
| Audit log is local                              | An attacker with process or database access can rewrite verifiable history.                                |
| `node:sqlite` is experimental                   | The storage API may change between Node minors.                                                            |
| Providers share the process                     | A malicious provider is not contained by the scoped resolver alone.                                        |
| No rate limiting                                | The runtime binds to `127.0.0.1` by default and assumes a trusted network position.                        |
| Redacted plans are not independently verifiable | See the asymmetry above.                                                                                   |

## What is tested

The security properties above are covered by automated tests, not just intent:

- secrets absent from plans, stored plans, inspections, audit events and
  verification results, while still applied to the provider
  (`packages/core/test/guardrails.test.ts`)
- approval refused without policy satisfaction, invalidated by a changed document,
  and not revivable by re-planning after expiry
- drift detected via revision and via `If-Match`
- plan tampering caught by hash recomputation
- audit tampering caught by editing a row through a second database connection
- deletions blocked at both gates, with the resource still present afterwards
- every provider checked for side-effect freedom, plan determinism, apply
  idempotency and secret containment by the conformance suite
- the uniform error envelope asserted to contain no stack trace
