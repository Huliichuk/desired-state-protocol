# DSP 0.1 — Desired State Protocol Specification

**Protocol version:** `0.1.0`
**API version string:** `dsp.dev/v1alpha1`
**Status:** draft, pre-1.0. Breaking changes are expected before `1.0`.

## 1. Scope and conventions

DSP specifies how a client — typically an AI agent — changes the state of an
external system by submitting a declarative description of the intended end state,
and how an implementation turns that description into a reviewable, verifiable
change.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are to
be interpreted as described in RFC 2119.

Within this document, _runtime_ means a DSP implementation, and _provider_ means a
component registered with a runtime that adapts one or more external systems.

The normative machine-readable contract is the set of JSON Schemas in
[`schemas/`](schemas): `manifest.schema.json`, `desired-state.schema.json`,
`plan.schema.json`, `result.schema.json` and `policy.schema.json`. Where this
document and a schema disagree, that is a defect in one of them and MUST be fixed;
neither silently overrides the other.

## 2. Terminology

| Term                       | Meaning                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------ |
| **Desired State document** | A client-supplied document describing what SHOULD be true.                           |
| **Kind**                   | The type of a Desired State document, e.g. `MockWorkspace`.                          |
| **Current state**          | What a provider observes in the external system.                                     |
| **Resource instance**      | One normalized resource: a resource type, a key, and attributes.                     |
| **Projection**             | The flat set of resource instances derived from a document or from observed state.   |
| **Resource type**          | A leaf type such as `mock.database`, with declared capabilities and field semantics. |
| **Change**                 | One planned action on one resource instance.                                         |
| **Plan**                   | An immutable, hashed, ordered set of changes with risk and policy results.           |
| **Plan hash**              | The SHA-256 digest that identifies a plan's content.                                 |
| **Policy bundle**          | The ordered set of policies a runtime evaluates.                                     |
| **Operation**              | One execution of one plan.                                                           |
| **Revision**               | An opaque token identifying a version of the observed state.                         |
| **Drift**                  | The observed state changing between plan and apply.                                  |
| **Actor**                  | The human, agent or system credited with a request in the audit log.                 |
| **Tenant**                 | The isolation scope for idempotency keys. `local` in 0.1.                            |

## 3. Protocol discovery

A runtime MUST serve a manifest at:

```
GET /.well-known/dsp
```

The manifest MUST validate against `manifest.schema.json`. It MUST be reachable
without authentication, so that a client can discover how to authenticate.

The manifest MUST declare:

- `protocol`, which MUST be the string `dsp`
- `protocolVersion`, a semantic version
- `server.name` and `server.version`
- `endpoints`, mapping each protocol operation to a path
- `features`, declaring which optional behaviours the runtime implements
- `authentication`, the supported schemes
- `limits`, the runtime's enforced bounds

A runtime MUST NOT advertise a feature it does not implement. In particular,
`features.destructiveChanges` MUST be `false` unless the runtime is willing to
execute `delete` and `replace` changes.

A runtime MUST publish its resource types and kinds:

```
GET /v1/resource-types
GET /v1/resource-types/{resourceType}
GET /v1/resource-types/{resourceType}/schema
GET /v1/kinds
GET /v1/kinds/{kind}
GET /v1/kinds/{kind}/schema
```

A runtime MUST NOT expose an operation-oriented tool surface as part of DSP. What
it publishes is what state it can make true, not what calls it can make.

## 4. Resource model

### 4.1 Resource types

A resource type describes a leaf resource. It MUST declare:

| Field             | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `name`            | Fully qualified, e.g. `stripe.product`. Unique within a runtime. |
| `provider`        | The owning provider's name.                                      |
| `capabilities`    | `inspect`, `plan`, `apply`, `verify`, `delete`, each a boolean.  |
| `identityFields`  | Attribute paths that constitute the resource's identity.         |
| `immutableFields` | Attribute paths that cannot change on an existing resource.      |
| `sensitiveFields` | Attribute paths that MUST be redacted outside the runtime.       |
| `attributeSchema` | JSON Schema for the resource's attributes.                       |

It MAY declare `riskFactors`: `financial`, `externallyVisible`, `permissionScope`,
`sensitive`. These feed the risk score (§10).

`immutableFields` and `sensitiveFields` patterns MAY use `[]` to match any array
index and a trailing `*` to match any suffix. `prices[].currency` matches
`prices[0].currency` and `prices[7].currency`.

A runtime MUST refuse to start if two providers declare the same resource type name
or the same kind.

### 4.2 Kinds

A kind describes a document type. It MUST declare `kind`, `provider`, a
`specSchema` for the document's `spec`, and the `resourceTypes` it can project
into. Every name in `resourceTypes` MUST be a declared resource type.

## 5. Desired State documents

A Desired State document MUST validate against `desired-state.schema.json`:

```ts
interface DesiredStateDocument<TSpec = unknown> {
  apiVersion: 'dsp.dev/v1alpha1'
  kind: string
  metadata: {
    name: string
    namespace?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    requestId?: string
  }
  spec: TSpec
}
```

`apiVersion`, `kind`, `metadata.name` and `spec` are REQUIRED. `metadata.name` and
`metadata.namespace` MUST match `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`. Unknown
properties MUST be rejected, at the top level and inside `metadata`; a typo MUST
NOT be silently ignored.

A document's identity within a runtime is `kind/namespace/name`, where an omitted
namespace defaults to `default`.

A document **MUST NOT** contain a plaintext credential. Credentials MUST be
referenced:

```yaml
credentials:
  secretRef:
    name: stripe-production
```

`metadata.labels` and `metadata.annotations` are opaque metadata. A runtime **MUST
NOT** derive authorization or policy scope from them. In particular the evaluated
environment MUST come from runtime configuration (§21).

### 5.1 The contract

A document MAY carry a contract, beside `spec` rather than inside it: it is protocol
machinery, so every provider gets it without modelling anything.

```ts
interface DesiredStateContract {
  goal?: string
  constraints?: ContractPredicate[]
  success?: ContractPredicate[]
}

interface ContractPredicate {
  id: string
  expression: string
  message?: string
}
```

A document states the shape a system should have. A contract states what that shape
was _for_. Without one, verification can only answer whether the world matches the
document, which is a different question from whether the change achieved anything: a
document that asks for an inactive subscription verifies perfectly and bills nobody.

**Expressions.** An expression MUST be a [CEL](https://cel.dev) expression that
evaluates to a boolean. A runtime MUST NOT accept a Turing-complete expression
language here: a predicate is evaluated by the runtime on a client's behalf, so it
MUST terminate in bounded time.

The evaluation environment MUST expose exactly one binding:

```
resources: list of { type: string, key: string, attributes: map }
```

A runtime **MUST NOT** expose the environment, the actor, the tenant, the policy
bundle or the clock to a contract expression. An expression able to read the
environment would appear to reason about trust, and it MUST NOT be able to.

**Evaluation is total.** A predicate that cannot be evaluated — a syntax error, an
unknown binding, a missing field, a non-boolean result — MUST be reported as an
error and MUST NOT be reported as a plain `false`. "The answer is no" and "there is
no answer" are different findings, and a contract that silently reads as unsatisfied
because of a typo is worse than one that names the typo.

```ts
interface PredicateResult {
  id: string
  expression: string
  satisfied: boolean
  message: string | null
  error: string | null
}

interface ContractCheck {
  goal: string | null
  predicates: PredicateResult[]
  satisfied: boolean
}
```

`satisfied` on a `ContractCheck` MUST be true only when every predicate was
evaluated and every one held.

**Constraints** are evaluated at plan time against the desired projection.
**Success** conditions are evaluated after apply against the projection of the state
the provider actually reports (§17).

A runtime MUST reject a document whose contract cannot be evaluated, with
`CONTRACT_PREDICATE_INVALID`, at validate time rather than at plan time. Predicate
ids MUST be unique within a group so a result can always be attributed. A runtime
MUST bound the number of predicates and the length of an expression.

**Constraints are a self-check, not an access control.** A client chooses its own
constraints and MAY choose weak ones, exactly as it MAY claim a weak environment
(§21). A runtime **MUST NOT** treat a constraint as an authorization decision.
Operator-imposed limits live in the policy bundle (§11), which a client cannot
influence. A document with no constraints is not less safe than one with many.

## 6. Current state and revisions

```ts
interface CurrentState<TState = unknown> {
  resourceType: string
  resourceId: string | null
  observedAt: string
  revision?: string
  state: TState | null
}
```

`revision` is an opaque token that MUST change whenever the observed state changes.
A provider MAY implement it as an ETag, a database version, or a hash of the
normalized state. A runtime uses it for optimistic concurrency control (§19).

## 7. Normalization and canonical JSON

Before hashing or diffing, a runtime MUST normalize:

1. Each side is projected into a flat set of resource instances.
2. Resource keys MUST be unique within a projection; duplicates MUST be rejected.
3. Resources MUST be sorted by key.
4. `dependsOn` lists MUST be sorted.
5. Attribute objects MUST be canonicalized.

All DSP hashes are SHA-256 over the **canonical JSON** form, following RFC 8785:

- object keys sorted by UTF-16 code unit
- array order preserved
- numbers serialized by the ECMAScript number-to-string algorithm, with `-0`
  normalized to `0`
- `undefined` object properties omitted
- non-finite numbers rejected

Hashes MUST be written as `sha256:` followed by 64 lowercase hex digits.

Attribute paths use a dotted notation with bracketed array indices:
`prices[0].currency`. A leaf is a primitive, an empty object, or an empty array.

## 8. Diff

Given a normalized desired projection `D` and current projection `C`, a runtime
MUST derive exactly one change per resource key in `D ∪ C`:

| Condition                                       | Action    |
| ----------------------------------------------- | --------- |
| key in `D`, not in `C`                          | `create`  |
| key in both, attributes canonically equal       | `noop`    |
| key in both, only mutable fields differ         | `update`  |
| key in both, an immutable field's value changed | `replace` |
| key in `C`, not in `D`                          | `delete`  |

A field path present on only one side is an **addition or removal**, not a mutation
of an immutable field. Appending an element to a list MUST NOT be reported as an
immutable-field violation.

When a container is empty on one side and populated on the other, the container's
own path MUST NOT be reported as a change alongside the leaves that replaced it.

### 8.1 Blocking

A change MUST be converted to action `blocked`, preserving `before` and `after` for
review, when any of the following holds:

| Condition                                                                 | `blockedBy`                  |
| ------------------------------------------------------------------------- | ---------------------------- |
| intended `delete` and deletions are not enabled                           | `DESTRUCTIVE_ACTION_BLOCKED` |
| intended `replace` and replacements are not enabled                       | `DESTRUCTIVE_ACTION_BLOCKED` |
| the resource type declares `capabilities.delete: false` for a `delete`    | `UNSUPPORTED_OPERATION`      |
| the resource type declares `capabilities.apply: false` for any non-`noop` | `UNSUPPORTED_OPERATION`      |

A `noop` MUST NOT be blocked. A blocked change MUST NOT be executed (§16).

The change identifier MUST be derived from the resource type, resource key and
_intended_ action, so that blocking does not change a change's identity.

### 8.2 Reversibility and destructiveness

`destructive` MUST be `true` for `delete` and `replace`. `reversible` MUST be
`true` only for `update` and `noop`: a `create` can only be undone by deleting,
which a runtime with destructive operations disabled cannot do.

## 9. Dependency ordering

A resource instance MAY declare `dependsOn`, a list of resource keys that MUST
exist before it is applied. A runtime MUST:

1. translate resource dependencies into change dependencies
2. invert the edges for `delete` changes, so a resource is removed only after
   everything depending on it
3. ignore dependencies pointing outside the plan
4. order changes topologically, with a deterministic tie-break so that identical
   input always yields identical order
5. reject a cyclic graph with `DEPENDENCY_CYCLE_DETECTED`, naming one concrete
   cycle

The reference tie-break sorts ready changes by action rank
(`create`, `update`, `replace`, `delete`, `noop`, `blocked`), then resource type,
then resource key.

## 10. Risk

Risk MUST be deterministic. A runtime **MUST NOT** use a language model to compute
risk.

A per-change score is the sum of the applicable weights:

| Factor                                                           | Weight |
| ---------------------------------------------------------------- | ------ |
| `delete`                                                         | 45     |
| `replace`                                                        | 35     |
| not reversible                                                   | 10     |
| production environment                                           | 20     |
| staging environment                                              | 8      |
| touches a declared sensitive field, or a sensitive resource type | 15     |
| financial resource type                                          | 15     |
| permission-scope resource type                                   | 15     |
| externally visible resource type                                 | 5      |

`noop` and `blocked` changes score `0`.

The plan score is the riskiest change's score plus a blast-radius weight derived
from the number of changes that will actually execute:

| Executing changes | Weight |
| ----------------- | ------ |
| 0–1               | 0      |
| 2–5               | 6      |
| 6–20              | 12     |
| 21+               | 20     |

Scores are clamped to `0..100` and mapped to levels:

```
0–19    low
20–49   medium
50–79   high
80–100  critical
```

## 11. Policy

A policy document MUST validate against `policy.schema.json`. Policy evaluation
MUST be deterministic and **MUST NOT** use a language model.

```yaml
apiVersion: dsp.dev/v1alpha1
kind: Policy
metadata:
  name: production-safety
spec:
  rules:
    - id: block-delete
      when:
        action: delete
      effect: deny
      message: Destructive operations are disabled
```

A rule has an `id`, an `effect`, and optionally a `when` condition, `constraints`,
a `message` and `minApprovals`.

**Effects.** `allow` and `warn` record a decision without changing the outcome.
`deny` makes the plan non-executable. `requireApproval` adds an approval
requirement.

**Conditions.** `action`, `resourceType` (exact, list, or a trailing `*` prefix),
`kind`, `environment`, `riskIn`, `destructive`, `pathPrefix`. All present
conditions MUST match. A rule scoped to a different `environment` or `kind` MUST
NOT fire at all.

**Constraints.** `maxChanges` bounds the matching changes; `maxTotalChanges` bounds
all executing changes. A rule with constraints fires only when a constraint is
**exceeded**.

`noop` and `blocked` changes MUST be invisible to policy evaluation: they never
reach the external system.

```ts
interface PolicyEvaluationResult {
  allowed: boolean
  decisions: PolicyDecision[]
  requiredApprovals: ApprovalRequirement[]
}
```

Policies MUST be evaluated in a stable order — the reference implementation sorts
by policy name — so that the decision list, and therefore the plan hash, does not
depend on load order. The **policy bundle hash** is the canonical hash of the
sorted bundle, and it is part of every plan.

## 12. Plan

```ts
interface DSPPlan {
  apiVersion: 'dsp.dev/v1alpha1'
  kind: 'Plan'
  metadata: {
    id: string
    createdAt: string
    expiresAt: string
    desiredStateHash: string
    currentStateHash: string
    policyBundleHash: string
    planHash: string
    kind: string
    namespace: string
    resourceName: string
    provider: string
    currentRevision: string | null
  }
  summary: PlanSummary
  changes: PlanChange[]
  approvals: { required: boolean; requirements: ApprovalRequirement[] }
  policyEvaluation: PolicyEvaluationResult
  executable: boolean
}
```

A plan MUST be immutable once created.

### 12.1 What the plan hash covers

`planHash` MUST be the canonical hash of exactly:

`apiVersion`, `kind`, `desiredStateHash`, `currentStateHash`, `policyBundleHash`,
`summary`, `changes`, `approvals`, `policyEvaluation`, `contract`, `executable`.

Covering `contract` means a changed goal produces a different plan, so an approval
cannot carry across a change of intent even when the resulting changes are identical.

It MUST NOT cover `metadata.id`, `metadata.createdAt` or `metadata.expiresAt`.
Timestamps are not part of intent, and including them would make planning
non-deterministic.

`desiredStateHash` MUST exclude `metadata.requestId`, which is correlation data.

### 12.2 Determinism

For the same desired state, current state, resource types, policy bundle and
options:

```
plan(current, desired, policies) = plan(current, desired, policies)
```

The two plans MUST have equal `planHash`, equal `id` and equal `changes`.

`metadata.id` MUST be derived from `planHash`. The reference derivation is
`plan_` followed by the first 24 hex digits of the digest. A consequence is that
re-planning an unchanged world lands on the plan that already exists.

### 12.3 Validity window

A plan MUST carry `expiresAt`. A runtime MUST refuse to apply or approve an expired
plan.

Re-planning onto an existing, unexpired plan **MUST NOT** extend that plan's
window. Extending it would reduce the TTL to a formality and keep an old approval —
which is bound to the hash — alive indefinitely. Once the window has closed, a
re-plan MAY open a new one, and §14 then invalidates approvals from the old window.

### 12.4 Executability

`executable` MUST be `policyEvaluation.allowed` and, when the document declared
constraints, `contract.satisfied`. A document whose own declared bounds do not hold
is internally contradictory and MUST NOT be applied.

`plan.contract` MUST be the evaluated constraints, or `null` when the document
declared no contract at all. A runtime MUST NOT report an absent contract as a
vacuously satisfied one.

Blocked changes do not make a plan non-executable: they are skipped at apply time,
and verification then reports that the desired state does not hold.

## 13. Provider refinement

A runtime MAY let the owning provider refine the computed changes before risk
scoring, to annotate what the generic diff cannot know.

A refinement MAY change `reason`, `destructive`, `reversible` and `estimatedRisk`.

A refinement **MUST NOT** change the number of changes, their order, or any of
`id`, `action`, `resourceType`, `resourceKey`, `dependencies`, `before`, `after`.
A runtime MUST reject a refinement that does, with `PROVIDER_ERROR`. A provider
MUST NOT be able to widen a plan behind the runtime's back.

## 14. Approval

```
POST /v1/plans/{planId}/approve
{ "approvedBy": "...", "reason": "...", "planHash": "sha256:..." }
```

The request MUST carry the exact `planHash` being approved. A runtime MUST reject a
mismatched hash with `APPROVAL_INVALID`.

An approval is valid only for:

1. the plan hash it names, and
2. the plan's current validity window — an approval recorded before
   `metadata.createdAt` MUST NOT count.

A changed Desired State produces a different hash and therefore a different plan,
so an approval MUST NOT carry over to it.

Where a requirement declares `minApprovals: n`, a runtime MUST require `n` distinct
approvers.

## 15. Apply

```
POST /v1/plans/{planId}/apply
Idempotency-Key: <required>
If-Match: <optional current-state revision>
```

Apply MUST accept a plan id. Apply **MUST NOT** accept a Desired State document,
under any parameter name. This is the control that makes the rest of the protocol
meaningful: whatever the client says at apply time, only the reviewed plan can run.

A runtime MUST check the following preconditions, in this order:

1. **Idempotency replay.** If `tenant + planId + idempotencyKey` has been used,
   return the existing operation and stop. This MUST be checked before anything
   observes or changes the world: a replay already changed the state it would
   otherwise be compared against.
2. **Plan integrity.** Recompute `planHash`; a mismatch is `PLAN_HASH_MISMATCH`.
3. **Expiry.** An expired plan is `PLAN_EXPIRED`.
4. **Executability.** A non-executable plan is `PLAN_NOT_EXECUTABLE`.
5. **Policy bundle identity.** If the runtime's bundle hash differs from
   `metadata.policyBundleHash`, refuse with `POLICY_DENIED`; a new plan is required.
6. **Policy re-evaluation.** Re-evaluate the bundle against the plan's changes; a
   denial is `POLICY_DENIED`.
7. **Approvals.** Unsatisfied requirements are `APPROVAL_REQUIRED`.
8. **Drift.** Re-read the revision; see §19.

Only then MUST the runtime create the operation, claim the idempotency key
atomically, and execute.

After execution, a runtime MUST run verification (§17).

## 16. Execution

```ts
type ChangeStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'blocked' | 'compensated'

type OperationStatus =
  | 'created'
  | 'running'
  | 'partially_completed'
  | 'completed'
  | 'failed'
  | 'verification_failed'
  | 'cancelled'
```

A runtime MUST:

- execute only changes contained in the plan, in the plan's order
- never execute a `blocked` change; record it as `blocked`
- record a `noop` change as `skipped` without calling the provider
- skip a change whose dependencies are not satisfied, recording an error, rather
  than attempting it. A dependency is satisfied when it succeeded, and also when it
  was a `noop`: a noop means the resource is already in the desired state, which is
  what the dependency asked for. A failed, blocked, or transitively skipped
  dependency does not satisfy it. Requiring success alone would make it impossible
  to add a resource under a parent that already exists.
- never re-execute a change already recorded as `succeeded`
- retry **only** errors marked retryable, with exponential backoff, up to a
  configured attempt limit
- impose a timeout on every provider call, surfaced as `PROVIDER_TIMEOUT`
- support cancellation between changes
- record provider request ids and external ids per change

Final operation status MUST be:

| Condition                                                   | Status                |
| ----------------------------------------------------------- | --------------------- |
| every change succeeded, skipped as `noop`, and none blocked | `completed`           |
| some failed and none succeeded                              | `failed`              |
| otherwise, with any failure, block or dependency skip       | `partially_completed` |
| cancellation observed before completion                     | `cancelled`           |

After verification (§17) a `completed` operation MUST become `goal_not_satisfied`
when the document declared success conditions and they do not hold. Structural
failure takes precedence: if the observed state also disagrees with the document,
the status MUST be `verification_failed`, because that is the more basic problem.

A runtime MUST NOT roll back succeeded changes on a later failure in 0.1.
Compensation is out of scope for this version.

## 17. Verification

Verification MUST re-read the provider's actual state and compare it, leaf by leaf,
with the desired projection. A runtime MUST NOT treat a provider's success report
as evidence that the state is correct.

```ts
interface VerificationResult {
  operationId: string
  status: 'satisfied' | 'partially_satisfied' | 'not_satisfied' | 'verification_failed'
  satisfaction: number
  verifiedAt: string
  matched: string[]
  unmatched: VerificationMismatch[]
}
```

`verification.contract` MUST carry the evaluated success conditions, or `null` when
the document declared none. Structural agreement and goal achievement MUST be
reported side by side and MUST NOT be collapsed into one value: they are different
claims, and an implementation that reports only the first can report success for a
change that achieved nothing.

`satisfaction` MUST be the fraction of checked leaf paths that matched, in `0..1`.
Only paths present in the desired projection are checked: **extra observed
attributes are not violations**, because DSP describes the state it owns rather
than the whole system.

Values at declared sensitive paths MUST be redacted in mismatch reports.

If verification cannot be completed, status MUST be `verification_failed`.

An operation whose execution `completed` but whose verification is not `satisfied`
MUST be recorded as `verification_failed`.

## 18. Idempotency

Every apply request MUST carry a non-empty `Idempotency-Key`; a runtime MUST
otherwise refuse with `IDEMPOTENCY_KEY_REQUIRED`.

Uniqueness is `tenant + planId + idempotencyKey`. A repeated request MUST NOT
create a new operation, MUST NOT repeat external changes, and MUST return the
existing operation. The claim MUST be atomic, so that two concurrent applies with
the same key produce one operation.

In 0.1 `tenant` MAY be the constant `local`.

## 19. State drift

Before executing, a runtime MUST re-read the current revision and compare it with
`metadata.currentRevision`. If they differ, it MUST refuse with
`STATE_DRIFT_DETECTED`, reporting `expectedRevision` and `actualRevision`.

A stale plan **MUST NOT** be applied automatically. A new plan is required.

If the client supplied `If-Match`, a runtime MUST also refuse when the supplied
revision does not match the observed one.

## 20. Error model

Every error response MUST use exactly one envelope:

```json
{
  "error": {
    "code": "STATE_DRIFT_DETECTED",
    "message": "Current state changed after the plan was created",
    "retryable": false,
    "details": { "expectedRevision": "abc", "actualRevision": "def" },
    "requestId": "req_123"
  }
}
```

A response MUST NOT contain a stack trace, a provider internal, or a credential. An
unexpected internal failure MUST be reported as `INTERNAL_ERROR` with a generic
message.

| Code                         | HTTP | Retryable | Meaning                                             |
| ---------------------------- | ---- | --------- | --------------------------------------------------- |
| `VALIDATION_FAILED`          | 422  | no        | The document or request failed semantic validation. |
| `SCHEMA_VALIDATION_FAILED`   | 422  | no        | The document failed JSON Schema validation.         |
| `IMMUTABLE_FIELD_CHANGED`    | 422  | no        | A field that cannot change was changed.             |
| `UNKNOWN_KIND`               | 404  | no        | No provider serves this kind.                       |
| `UNKNOWN_RESOURCE_TYPE`      | 404  | no        | No provider declares this resource type.            |
| `PROVIDER_NOT_FOUND`         | 404  | no        | No provider is registered for the target.           |
| `PROVIDER_ERROR`             | 502  | varies    | The provider failed.                                |
| `PROVIDER_TIMEOUT`           | 504  | yes       | A provider call exceeded its timeout.               |
| `SECRET_NOT_FOUND`           | 400  | no        | A referenced secret is not configured.              |
| `SECRET_ACCESS_DENIED`       | 403  | no        | A secret was requested that was not declared.       |
| `POLICY_DENIED`              | 403  | no        | Policy refused the plan.                            |
| `CONTRACT_VIOLATED`          | 422  | no        | A declared constraint does not hold.                |
| `CONTRACT_PREDICATE_INVALID` | 422  | no        | A contract expression cannot be evaluated.          |
| `APPROVAL_REQUIRED`          | 409  | no        | The plan needs approval it does not have.           |
| `APPROVAL_INVALID`           | 409  | no        | The approval does not match the plan.               |
| `PLAN_NOT_FOUND`             | 404  | no        | No such plan.                                       |
| `PLAN_EXPIRED`               | 409  | no        | The plan is past its validity window.               |
| `PLAN_NOT_EXECUTABLE`        | 409  | no        | The plan was not executable when created.           |
| `PLAN_HASH_MISMATCH`         | 409  | no        | The stored plan no longer matches its hash.         |
| `STATE_DRIFT_DETECTED`       | 409  | no        | The world changed after the plan was created.       |
| `OPERATION_NOT_FOUND`        | 404  | no        | No such operation or audit event.                   |
| `OPERATION_ALREADY_RUNNING`  | 409  | no        | The operation is already executing.                 |
| `IDEMPOTENCY_KEY_REQUIRED`   | 400  | no        | Apply was called without a key.                     |
| `IDEMPOTENCY_KEY_CONFLICT`   | 409  | no        | The key is in use for different content.            |
| `DESTRUCTIVE_ACTION_BLOCKED` | 403  | no        | A destructive action was refused.                   |
| `DEPENDENCY_CYCLE_DETECTED`  | 422  | no        | Resource dependencies form a cycle.                 |
| `DOCUMENT_TOO_LARGE`         | 413  | no        | The document exceeds the byte limit.                |
| `DOCUMENT_TOO_DEEP`          | 422  | no        | The document exceeds the nesting limit.             |
| `TOO_MANY_RESOURCES`         | 422  | no        | The projection exceeds the resource limit.          |
| `TOO_MANY_CHANGES`           | 422  | no        | The plan exceeds the change limit.                  |
| `UNSUPPORTED_OPERATION`      | 501  | no        | The operation is not supported here.                |
| `NOT_IMPLEMENTED`            | 501  | no        | The feature is not implemented in this version.     |
| `UNAUTHORIZED`               | 401  | no        | Authentication is missing or invalid.               |
| `FORBIDDEN`                  | 403  | no        | Authenticated but not permitted.                    |
| `CANCELLED`                  | 409  | no        | The operation was cancelled or is terminal.         |
| `VERIFICATION_FAILED`        | 200  | no        | Verification could not be completed.                |
| `INTERNAL_ERROR`             | 500  | no        | An unexpected internal failure.                     |

Validation of a Desired State document is **not** an error: `POST /v1/validate`
MUST return `200` with a `ValidationResult` for an invalid document.

## 21. Authentication and attribution

DSP 0.1 defines bearer-token authentication. A runtime MUST require a bearer token
on every endpoint except `/health`, `/.well-known/dsp` and its OpenAPI document,
which MUST be reachable unauthenticated so a client can discover the runtime.

Token comparison SHOULD be constant-time.

A client MAY describe itself with `X-DSP-Actor-Type` (`human`, `agent`, `system`)
and `X-DSP-Actor-Id`. These are **attribution for the audit log only**. A runtime
**MUST NOT** derive any authorization from them.

The evaluated environment MUST come from runtime configuration. A runtime **MUST
NOT** take it from the document, including from `metadata.labels`, because a client
that could choose its own environment could choose weaker policy.

A runtime SHOULD be architected so that OAuth 2.1 and workload identity can be
added without changing the protocol surface.

## 22. Provider requirements

A provider MUST:

- declare at least one kind and one resource type, with every referenced resource
  type declared
- implement `validate`, `inspect`, `normalizeDesired`, `normalizeCurrent` and
  `applyChange`
- make `validate`, `inspect` and `plan` **free of side effects**
- make `normalizeDesired` and `normalizeCurrent` **pure**
- produce unique, stable resource keys, derived from identity fields
- express document nesting as explicit `dependsOn` edges
- make `applyChange` **idempotent**: applying the same change twice MUST leave the
  same observed state and MUST NOT create a duplicate
- honour the abort signal on its context
- declare every credential-shaped attribute it accepts in `sensitiveFields`
- report failures with an accurate `retryable` flag
- never return a credential value through any method

A provider MUST NOT receive unrestricted access to the secret store. It MUST
receive only a resolver scoped to the references its own `requiredSecrets`
declared for the document at hand.

A provider MUST NOT dereference a URL taken from a Desired State document.

## 23. Security requirements

A conforming runtime MUST:

1. keep provider credentials out of the client's reach entirely
2. perform no external change during `validate`, `inspect` or `plan`
3. accept only a plan id at apply
4. disable `delete` and `replace` by default, and refuse to enable them per request
5. operate provider credentials under least privilege
6. redact secrets in plans, audit events, HTTP responses, error details, logs, CLI
   output and telemetry
7. prevent SSRF by refusing to dereference document-supplied URLs
8. enforce limits on document size, JSON depth, resource count, change count and
   provider call duration
9. record every lifecycle action in a tamper-evident audit log

## 24. Audit log

Every action MUST be recorded as an append-only event:

```ts
interface AuditEvent {
  id: string
  sequence: number
  timestamp: string
  actor: { type: 'human' | 'agent' | 'system'; id: string }
  action: string
  resourceType?: string
  resourceKey?: string
  planId?: string
  operationId?: string
  requestId?: string
  outcome: 'success' | 'failure' | 'blocked'
  metadata: Record<string, unknown>
  previousEventHash: string | null
  eventHash: string
}
```

`sequence` MUST start at 1 and increase by 1. `previousEventHash` MUST be the
predecessor's `eventHash`, or `null` for the first event. `eventHash` MUST be the
canonical hash of the event body including `previousEventHash`.

Verification MUST check sequence continuity, back-links and every hash, and MUST
report the first broken event.

This is a **tamper-evident** chain, not a tamper-proof one, and not a blockchain:
it detects modification of stored history, and does not prevent it.

## 25. Conformance

An implementation conforms to DSP 0.1 if it satisfies every **MUST** in this
document, serves a manifest that validates against `manifest.schema.json`, and
emits plans and operations that validate against `plan.schema.json` and
`result.schema.json`.

Every provider MUST pass the provider conformance suite, which checks at minimum:

```
inspect is side-effect free
validate is side-effect free
plan is side-effect free
normalizeDesired is pure
the same inputs produce the same plan
apply executes only what the plan contains
apply is idempotent
verify reads actual provider state
secrets are never returned
unsupported deletes are blocked rather than performed
```

## 26. Version negotiation

A runtime advertises `protocolVersion` in its manifest. A client SHOULD read it
before its first request and SHOULD refuse to proceed on a major-version mismatch.

Within `0.x` a client SHOULD treat a minor-version difference as potentially
breaking and SHOULD verify the features it depends on through `features` rather
than assuming them.

A runtime MUST reject a document whose `apiVersion` it does not serve rather than
attempting to interpret it.

## Appendix A — a worked example

A document:

```yaml
apiVersion: dsp.dev/v1alpha1
kind: MockWorkspace
metadata:
  name: dsp-demo
spec:
  databases:
    - name: main
      engine: postgres
      region: eu-central-1
      tables:
        - name: users
          columns:
            - name: id
              type: text
```

Projects into two resource instances:

```
mock.database/main                     {name, engine, region}
mock.table/main.users   dependsOn ─►   mock.database/main
```

Against an empty world, the diff produces two `create` changes; the graph orders
the database first. Risk: each `create` is irreversible (+10), neither is financial
or permission-scoped, and the environment is not production — so each change scores
10 (`low`), and the plan scores 10 + 6 (blast radius of two) = 16, still `low`.

The plan:

```json
{
  "apiVersion": "dsp.dev/v1alpha1",
  "kind": "Plan",
  "metadata": {
    "id": "plan_...",
    "planHash": "sha256:...",
    "currentRevision": "empty"
  },
  "summary": {
    "create": 2,
    "update": 0,
    "delete": 0,
    "replace": 0,
    "noop": 0,
    "blocked": 0,
    "risk": "low",
    "riskScore": 16
  },
  "executable": true
}
```

After `apply`, the operation is `completed` and verification is `satisfied` with
`satisfaction: 1`. Re-planning the same document now yields two `noop` changes.

If the document is then changed to `engine: mysql`, `engine` is immutable, so the
change becomes `replace`, and because replacements are disabled it is recorded as
`blocked` with `blockedBy: DESTRUCTIVE_ACTION_BLOCKED` — the existing database is
not destroyed to satisfy the new document.
