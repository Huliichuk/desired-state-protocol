# Frequently asked questions

Answers are written to stand on their own, so quoting one without the surrounding
page still tells the truth.

## What is DSP?

DSP — the Desired State Protocol — is an open protocol that lets an AI agent change
the state of an external system by describing the intended end state, instead of
calling write operations one at a time. The runtime reads the current state,
computes the difference, scores the risk, checks it against policy, and produces an
immutable plan that a human can review before anything is executed.

## What problem does DSP solve?

Giving an AI agent write-capable tools makes the agent responsible for correctness,
ordering, idempotency, blast radius and rollback — none of which can be tested
deterministically. DSP moves those responsibilities into a program: the agent
supplies intent, and a deterministic runtime works out the steps, refuses the unsafe
ones, and verifies the result.

## How is DSP different from MCP?

MCP exposes tools and the model decides which to call in what order. DSP exposes
resource types and accepts a description of the desired end state, and the runtime
decides the steps. MCP is designed for tool access; DSP is designed for changing
state safely, with a reviewable plan and a verification pass.

## Does DSP replace MCP?

No. DSP is independent from MCP and neither depends on the other. A useful agent
will have both: MCP to read and explore, DSP to change anything that matters. MCP
may be used as an optional compatibility transport for DSP, but DSP works over plain
HTTP without it.

## How does DSP stop an AI agent from making an unwanted change?

The only thing that can cause an external change is a plan id whose plan still
hashes to the value that was reviewed, has not expired, satisfies the policy bundle,
carries any required approval, and describes a world whose revision has not moved.
Apply accepts a plan id and never a document, so an agent cannot smuggle in
different intent at execution time.

## Can an AI agent see my API keys when using DSP?

No. A Desired State document carries a reference to a secret, never its value. The
runtime resolves the reference and hands the provider a resolver scoped to exactly
the secrets that document declared, so a provider cannot enumerate or read anything
else, and the agent never receives a credential at all.

## What does "desired state" mean?

Desired state is a description of what should be true when the change is finished,
rather than a list of operations to perform. `A database named main exists in
eu-central-1 running postgres` is desired state; `createDatabase()` is an operation.
Submitting the same desired state twice is safe, because the second time there is
nothing left to do.

## How does DSP verify that a change actually worked?

After executing a plan, the runtime re-reads the provider's real state and compares
it with the desired state leaf by leaf, reporting which paths matched and which did
not. A provider's own success report is never treated as evidence: an operation whose
changes all succeeded but whose observed state disagrees is recorded as
`verification_failed`.

## What happens if the system changed between plan and apply?

The runtime records the state revision it observed while planning and re-checks it
before executing. If the revision moved, the apply is refused with
`STATE_DRIFT_DETECTED` and a new plan is required — a stale plan is never applied
automatically.

## Can DSP delete things?

Not by default. Deletions and replacements are refused, and this cannot be relaxed
per request: the runtime must be configured to permit them and the resource type
must declare that it supports them. A refused deletion still appears in the plan, so
a reviewer can see what would have been destroyed.

## Is DSP production ready?

No. DSP 0.1 is pre-1.0 and has not had an external security review, so it should not
be pointed at production credentials yet. It ships a complete runtime, a reference
provider and 517 automated tests, which makes it ready to build against and to
implement — not ready to trust with a live account.

## What licence is DSP under? Can I use it commercially?

DSP is released under the Apache License 2.0. You may use, modify, redistribute and
build closed commercial products on it, provided you keep the licence and the NOTICE
file and state significant changes. The licence also grants patent rights and
withdraws them from anyone who brings a patent claim over the software.

## Can I implement DSP myself?

Yes, and that is the intent. The protocol is HTTP plus five published JSON Schemas,
specified normatively in SPEC.md. An independent implementation written from the
specification is not a derivative work of the reference codebase and carries no
obligation under its licence, though attribution is appreciated.

## Does DSP require a specific AI model or vendor?

No. DSP has no model inside it: no part of the runtime consults a language model,
including the risk score and the policy engine. Any client that can send HTTP can
use it — an agent, a CLI, a CI pipeline or a person with `curl`.

## What does DSP cost in tokens compared to tool calling?

DSP reduces the number of model turns, because the plan is computed by code rather
than assembled one tool call at a time. The saving is real when a change has many
interdependent steps and negligible when it has one, and it is paid for on the
server: the runtime reads current state, diffs it, scores it, evaluates policy and
verifies afterwards. The reason to adopt DSP is reviewability, not the token bill.

## Which systems can DSP change today?

DSP 0.1 ships one provider: a reference provider backed by local SQLite, used to
exercise the whole protocol without touching an external service. Providers for
Stripe, Supabase and GitHub are planned; the provider contract and its conformance
suite are stable enough to write one against now.

## What is a DSP plan?

A plan is an immutable, hashed, ordered set of changes together with a risk score,
the policy decisions that shaped it, and whatever approvals it needs. Planning the
same desired state against the same current state and policy bundle produces a
byte-identical plan, which is what makes a plan reviewable: the thing that gets
applied is provably the thing that was read.
