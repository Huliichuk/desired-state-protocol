# Writing a DSP provider

A provider adapts one external system to DSP. It is smaller than you expect,
because the runtime owns the parts that are easy to get wrong.

**The provider owns:** what resource types exist, what a document means, how to read
the world, and how to apply one change.

**The runtime owns:** the diff, dependency ordering, risk scoring, policy, plan
immutability and hashing, blocking destructive actions, idempotency across requests,
retries, timeouts, cancellation, verification and the audit log.

Worked example throughout: [`packages/provider-mock`](../packages/provider-mock).

## The contract

```ts
interface DSPProvider<TSpec = unknown, TState = unknown> {
  readonly name: string
  readonly version: string
  readonly kinds: KindDefinition[]
  readonly resourceTypes: ResourceTypeDefinition[]

  requiredSecrets(desired: DesiredStateDocument<TSpec>): SecretReference[]

  validate(ctx: ProviderContext, desired: DesiredStateDocument<TSpec>): Promise<ValidationResult>
  inspect(ctx: ProviderContext, desired: DesiredStateDocument<TSpec>): Promise<CurrentState<TState>>

  normalizeDesired(desired: DesiredStateDocument<TSpec>): Promise<ResourceProjection>
  normalizeCurrent(current: CurrentState<TState>): Promise<ResourceProjection>

  plan?(ctx: ProviderContext, input: ProviderPlanInput<TSpec, TState>): Promise<PlanChange[]>
  applyChange(ctx: ProviderExecutionContext, change: PlanChange): Promise<ChangeExecutionResult>
  verify?(ctx: ProviderContext, input: { desired; operation }): Promise<VerificationResult>
}
```

`plan` and `verify` are optional. Without `verify`, the runtime compares the desired
projection against a fresh `inspect`, which is usually what you want.

## Step 1 — declare what exists

### Resource types

```ts
export const mockResourceTypes: ResourceTypeDefinition[] = [
  {
    name: 'mock.subscription',
    provider: 'mock',
    description: 'A recurring charge attached to a workspace member',
    capabilities: { inspect: true, plan: true, apply: true, verify: true, delete: false },
    identityFields: ['user'],
    immutableFields: ['currency'],
    sensitiveFields: [],
    riskFactors: { financial: true, externallyVisible: true },
    attributeSchema: {/* JSON Schema for the attributes */},
  },
]
```

Four fields do real work, and getting them wrong is how providers become dangerous:

**`capabilities`** — the runtime consults these before planning anything. Set
`delete: false` unless the external system genuinely supports removal and you have
implemented it; the runtime will then block deletions with `UNSUPPORTED_OPERATION`
instead of trying. `apply: false` makes a type read-only.

**`identityFields`** — the attributes that make this resource _this_ resource. They
determine what "the same resource" means, and therefore whether a diff sees an
update or a create-and-orphan.

**`immutableFields`** — attributes the external system will not let you change in
place. A change to one of these becomes `replace`, which the runtime blocks by
default rather than destroying and recreating. Patterns support `[]` for any array
index and a trailing `*`: `prices[].currency` matches `prices[3].currency`.

**`sensitiveFields`** — attribute paths whose _values_ must never leave the runtime.
Declare every credential-shaped field you accept. The conformance suite fails a
provider that accepts a secret-looking value at a path it did not declare.

`riskFactors` feed the deterministic risk score: `financial` for anything that moves
money, `permissionScope` for anything that grants access, `externallyVisible` for
anything a customer can see, `sensitive` for a resource that is sensitive as a whole.

### Kinds

```ts
export const mockKindDefinition: KindDefinition = {
  kind: 'MockWorkspace',
  provider: 'mock',
  description: 'A synthetic workspace used to exercise the full DSP lifecycle',
  specSchema: mockWorkspaceSpecSchema,
  resourceTypes: Object.values(MOCK_RESOURCE_TYPES),
}
```

## Step 2 — write the spec schema

This is your public contract. It is served at `GET /v1/kinds/{kind}/schema`, and
clients validate against it before they ever call you.

Rules that pay off:

- **`additionalProperties: false` everywhere.** A silently ignored typo is a client
  that thinks it configured something it did not.
- **Constrain strings.** Use `pattern`, `minLength`, `maxLength`.
- **Do not rely on `format`.** In JSON Schema 2020-12 `format` is an annotation, not
  an assertion. Write a `pattern`:

```ts
email: {
  type: 'string',
  // A pattern rather than `format: email`, which would not actually validate.
  pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
  maxLength: 254,
}
```

- **Bound arrays** with `maxItems`. Combined with the runtime's resource limit, this
  keeps a single document from becoming a denial of service.
- **Use `enum` for closed sets** so the error message lists the valid values.

## Step 3 — projection

This is the part people get wrong, so it is worth the space.

The runtime diffs **flat sets of resource instances**, not documents. Your job is to
turn a nested document into that flat set, and to express nesting as explicit
dependency edges.

```ts
export function projectSpec(spec: MockWorkspaceSpec): ResourceProjection {
  const resources: ResourceInstance[] = []

  for (const database of spec.databases ?? []) {
    resources.push({
      resourceType: 'mock.database',
      key: databaseKey(database.name),
      attributes: compact({
        name: database.name,
        engine: database.engine,
        region: database.region,
        sizeGb: database.sizeGb,
      }),
    })

    for (const table of database.tables ?? []) {
      resources.push({
        resourceType: 'mock.table',
        key: tableKey(database.name, table.name),
        // Nesting in the document becomes an edge in the graph. This is how the
        // runtime knows a table cannot be created before its database.
        dependsOn: [databaseKey(database.name)],
        attributes: compact({ database: database.name, name: table.name, columns: table.columns }),
      })
    }
  }

  return { resources }
}
```

### Resource keys

A key identifies a resource **within one document's scope**. It must be:

- **stable** — the same logical resource must produce the same key on every run, and
  across versions of your provider. Change a key format and every existing resource
  looks deleted-and-recreated. Treat it like a database primary key.
- **unique** — the runtime rejects a projection with duplicate keys rather than
  silently dropping one.
- **derived from `identityFields`** — and from nothing else. Never derive a key from
  a mutable attribute, or an edit becomes a delete plus a create.
- **independent of order** — never use an array index. `users[0]` breaks the moment
  someone reorders the document.

The convention this repository uses is `<resourceType>/<identity>`:

```ts
const databaseKey = (name: string) => `mock.database/${name}`
const tableKey = (database: string, name: string) => `mock.table/${database}.${name}`
const userKey = (email: string) => `mock.user/${email}`
```

Keys appear in plans, audit events and verification paths, so a human will read
them. `mock.user/founder@example.com` is a better key than `mock.user/7f3a91`, even
though both are stable.

### External ids

`externalId` is the id in the external system, which you usually do not know until
after a create. Set it on the **current** projection from observed state; leave it
off the desired projection. The runtime carries it into the change and stores it on
the operation record, giving you a mapping from resource key to vendor id.

### Attributes

Only include what you actually manage. Every desired attribute becomes something
verification will check afterwards, so an attribute you set but cannot read back
will report as unsatisfied forever.

Omit absent optional fields rather than setting them to `undefined` or `null` —
canonical JSON drops `undefined` properties, but an explicit `null` is a value and
will diff against a missing field.

Normalize defaults **in the projection**, on both sides, or you will get a permanent
phantom diff:

```ts
// Both sides must agree that an unspecified `nullable` means false.
nullable: column.nullable ?? false
```

## Step 4 — secrets

Declare what a document needs, and take only that:

```ts
requiredSecrets(desired: DesiredStateDocument<MockWorkspaceSpec>): SecretReference[] {
  const reference = desired.spec.credentials?.secretRef
  return reference === undefined ? [] : [reference]
}
```

The runtime builds a resolver scoped to exactly this list. You never see the store,
and asking for anything else fails with `SECRET_ACCESS_DENIED`:

```ts
const resolved = await context.secrets.resolve({ name: 'stripe-production' })
const client = new Stripe(resolved.value.reveal())
```

`resolved.value` is a `SecretValue`. It returns `[REDACTED]` from `toString()`,
`toJSON()` and template interpolation, so it cannot be logged by accident. Reaching
the plaintext requires an explicit `.reveal()`, which is easy to grep for in review.

Never put a credential into a resource attribute. If a client must supply one
inline, declare that path in `sensitiveFields` and warn:

```ts
warnings.push({
  code: 'INLINE_SECRET',
  path: `spec.users[${index}].apiToken`,
  message: 'Inline API tokens are redacted, but a secretRef is preferred',
})
```

## Step 5 — validate

Schema validation already happened. `validate` is for what a schema cannot express,
and it **must not have side effects**.

```ts
async validate(context, desired): Promise<ValidationResult> {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  // Cross-references within the document.
  ;(desired.spec.subscriptions ?? []).forEach((subscription, index) => {
    if (!emails.has(subscription.user)) {
      errors.push({
        code: 'UNRESOLVED_REFERENCE',
        path: `spec.subscriptions[${index}].user`,
        message: `Subscription references user "${subscription.user}", which is not declared in spec.users`,
      })
    }
  })

  // Impossible changes against the world as it is now.
  const current = await this.inspect(context, desired)
  errors.push(...this.immutableViolations(desired, current))

  return { valid: errors.length === 0, errors, warnings }
}
```

Worth checking here: duplicates within the document, unresolved internal references,
and immutable-field changes against current state. The last one is reported twice on
purpose — as a validation error _and_ as a blocked change in the plan — so a caller
that only runs `validate` still learns the change is impossible.

Always report `path` in document coordinates (`spec.users[0].email`), never in
projection coordinates. The client wrote a document.

## Step 6 — inspect

Read the world. No side effects, and honour the abort signal:

```ts
async inspect(context, desired): Promise<CurrentState<MockWorkspaceState>> {
  context.signal.throwIfAborted()
  const id = this.workspaceId(desired)

  return {
    resourceType: 'MockWorkspace',
    resourceId: `${id.namespace}/${id.workspace}`,
    observedAt: context.now().toISOString(),
    revision: this.backend.revision(id),
    state: { resources: this.backend.list(id) },
  }
}
```

**`revision` matters.** It is what drift detection compares. It must change whenever
any observed state changes, and it must be stable when nothing has. Use an ETag if
the vendor gives you one, otherwise hash the normalized state:

```ts
revision(id: WorkspaceId): string {
  const resources = this.list(id)
  if (resources.length === 0) return 'empty'
  return hashCanonical(resources.map((r) => ({ key: r.key, revision: r.revision })))
}
```

A revision derived from a timestamp is a bug: it changes when nothing did, and every
plan then looks drifted.

Use `context.now()` rather than `new Date()`. The injected clock is what makes the
runtime testable.

## Step 7 — applyChange

One change. Idempotent. That is the whole job.

```ts
async applyChange(context, change): Promise<ChangeExecutionResult> {
  context.signal.throwIfAborted()

  // The change carries target attributes; document-level configuration such as
  // which account to talk to comes from the document.
  const desired = context.desired as DesiredStateDocument<MockWorkspaceSpec>
  const id = this.workspaceId(desired)

  if (change.action === 'blocked' || change.action === 'noop') {
    throw unsupportedOperation(`The runtime must not execute a "${change.action}" change`)
  }

  if (change.action === 'delete') {
    if (!this.backend.delete(id, change.resourceKey)) {
      throw providerError(`Resource "${change.resourceKey}" no longer exists`)
    }
    return { externalId: null, providerRequestId: this.requestId(context, change) }
  }

  const stored = this.backend.upsert(id, {
    resourceType: change.resourceType,
    key: change.resourceKey,
    attributes: change.after as Record<string, unknown>,
  })

  return {
    externalId: stored.externalId,
    providerRequestId: this.requestId(context, change),
    observed: stored.attributes,
  }
}
```

### Idempotency is your responsibility

The runtime deduplicates _requests_ through the idempotency key and never re-runs a
change already recorded as succeeded. It cannot help you if the process dies between
your API call and the record of it. Applying the same change twice must leave the
same state and must not create a duplicate.

In practice:

- prefer an upsert to a create
- if the vendor has an idempotency key, pass `context.idempotencyKey`
- if it does not, look the resource up by identity first and update if found
- treat "already exists" as success, not as an error

The conformance suite applies your whole plan twice and asserts the observed state is
identical.

### Errors

Use the SDK helpers and be honest about `retryable` — the execution engine trusts it:

```ts
import {
  providerError,
  providerTimeout,
  unsupportedOperation,
  notImplemented,
} from '@dsp/provider-sdk'

throw providerError('Rate limited by the vendor', { retryable: true }) // will be retried
throw providerError('The vendor rejected the currency', { retryable: false }) // will not
throw providerTimeout('No response within the budget') // retryable
throw unsupportedOperation('This resource type cannot be deleted')
throw notImplemented('subscription cancellation')
```

Marking a non-idempotent failure retryable is the most expensive mistake available
here: the runtime will do it again.

Never include a credential in a message or in `details`. They travel to the client
and into the audit log.

### What you must not do

- do not apply anything other than the change you were given
- do not apply a `blocked` or `noop` change
- do not perform work for other changes "while you are there" — ordering exists for
  a reason
- do not dereference a URL taken from the document (SSRF)
- do not swallow errors; a silent failure becomes a verification mismatch nobody can
  explain

## Step 8 — plan refinement (optional)

The generic diff cannot know your domain. `plan` lets you annotate what it computed:

```ts
async plan(_context, input): Promise<PlanChange[]> {
  return input.changes.map((change) => {
    if (change.resourceType !== 'mock.user' || change.action !== 'update') return change

    const roleChange = change.fields.find((field) => field.path === 'role')
    if (roleChange === undefined || roleChange.before !== 'admin') return change

    // Lowering a role removes access. The diff sees a string change; we know better.
    return {
      ...change,
      destructive: true,
      reversible: false,
      reason: `${change.reason}; removing admin access is treated as destructive`,
    }
  })
}
```

You **may** change `reason`, `destructive`, `reversible` and `estimatedRisk`. This
runs before risk scoring, so marking something destructive raises its score and can
trip a policy.

You **may not** change the number of changes, their order, or any of `id`, `action`,
`resourceType`, `resourceKey`, `dependencies`, `before`, `after`. The runtime checks
and rejects with `PROVIDER_ERROR`. A provider cannot widen a plan.

## Step 9 — the conformance suite

Not optional, and not a formality.

```ts
// packages/provider-mock/test/conformance.test.ts
import { runProviderConformanceSuite } from '@dsp/provider-sdk/conformance'

runProviderConformanceSuite<MyWorkspaceSpec, MyState>({
  name: 'my-provider',
  createProvider: () => new MyProvider({ backend: new MyBackend(':memory:') }),
  validDocument: () => document(baseSpec),
  documentWithResourceRemoved: () => document({ ...baseSpec, subscriptions: [] }),
  secretValues: { 'my-api': 'test-value' },
  reset: (provider) => provider.backend.close(),
})
```

It checks:

```
declares at least one kind and one resource type
declares resource types its kinds actually reference
accepts the document its own harness calls valid
inspect is side-effect free
validate is side-effect free
plan is side-effect free
normalizeDesired is pure
projects resources with unique, stable keys
projects dependencies that point at resources it also declares
the same inputs produce the same plan
apply executes only what the plan contains
apply is idempotent
re-planning after apply reports that nothing is left to do
verify reads actual provider state
refuses to execute a blocked or noop change
secrets are never returned through the provider surface
declares sensitive fields for every credential-shaped attribute it accepts
unsupported deletes are blocked rather than performed
```

If one fails, the provider has a real defect. The two that catch the most bugs are
_apply is idempotent_ and _re-planning after apply reports that nothing is left to
do_ — the second fails whenever a projection default is normalized on one side only.

## Testing beyond conformance

The mock provider deliberately supports failure simulation, and a real provider
benefits from the same idea:

```yaml
spec:
  simulate:
    failResourceKey: mock.subscription/founder@example.com
    failureMode: retryable # retryable | permanent | timeout
    failAttempts: 1 # succeed on attempt 2
    driftResourceKey: mock.database/main # corrupt state after a successful apply
```

That is how the retry path, the timeout path, partial failure, dependency skipping
and verification mismatch get covered without an unreliable network.

For unit tests, build contexts with the SDK helpers:

```ts
import { createTestContext, createTestExecutionContext } from '@dsp/provider-sdk'

const context = createTestContext({ secretValues: { 'my-api': 'test-value' } })
const execution = createTestExecutionContext({ desired: myDocument, attempt: 2 })
```

## Registering

```ts
import { createRuntime } from '@dsp/core'

const { runtime, close } = createRuntime({
  providers: [new MyProvider({/* ... */})],
  databasePath: '.dsp/runtime.sqlite',
})
```

The runtime refuses to start if two providers claim the same kind or the same
resource type name, so collisions surface at boot rather than at runtime.

## Checklist

- [ ] every resource type declares honest `capabilities`
- [ ] `identityFields`, `immutableFields`, `sensitiveFields` reflect the real system
- [ ] `riskFactors` set for financial, permission and externally visible resources
- [ ] spec schema uses `additionalProperties: false` and bounded arrays
- [ ] keys are stable, unique, order-independent, derived from identity
- [ ] nesting is expressed as `dependsOn`
- [ ] defaults normalized identically on both projection sides
- [ ] `requiredSecrets` declares exactly what is needed
- [ ] no credential in any attribute, message or error detail
- [ ] `validate`, `inspect`, `normalize*` and `plan` have no side effects
- [ ] `applyChange` is idempotent and honours the abort signal
- [ ] `retryable` is accurate on every error
- [ ] the conformance suite passes
