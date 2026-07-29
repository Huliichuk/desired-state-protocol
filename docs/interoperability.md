# Interoperability

How DSP sits next to the things that already exist.

## Adapters today, native servers later

DSP has two deployment shapes, and 0.1 only implements the first.

**Adapter (today).** A provider wraps a vendor's REST API, SDK or CLI and presents
it as resource types. The vendor does not know DSP exists. The runtime holds the
vendor credential, and the agent never does.

```
agent ──► DSP runtime ──► provider adapter ──► vendor REST API
```

The cost is honest: every adapter is code someone has to maintain against an API
that changes. The benefit is that DSP is useful immediately, without asking anyone's
permission.

**Native (later).** A vendor implements DSP directly: serves `/.well-known/dsp`,
publishes its resource types, and honours the lifecycle. The protocol is HTTP plus
five published JSON Schemas in [`schemas/`](../schemas); there is nothing else to
adopt.

```
agent ──► vendor's own DSP endpoint
```

A vendor gains plan/approve/verify and a reviewable diff without exposing a
write-capable tool surface. Same protocol, no adapter to maintain, and the vendor
keeps the authoritative model of its own resources.

The migration path is deliberate: a client written against an adapter works against
a native implementation unchanged, because it only ever spoke DSP.

## MCP

```
DSP is independent from MCP.

DSP can operate directly over HTTP, through SDKs, or through native provider
implementations. MCP may be used as an optional compatibility transport.
```

DSP Core, the server and every provider carry **no dependency on any MCP SDK**, and
none of them import one. That is checked by the package graph, not by intent.

### They answer different questions

|                        | MCP                                | DSP                                 |
| ---------------------- | ---------------------------------- | ----------------------------------- |
| Question               | "what can I call?"                 | "what should be true?"              |
| Unit                   | a tool                             | a resource type and a desired state |
| Who sequences the work | the model                          | the runtime                         |
| Review artifact        | a transcript                       | a hashed plan                       |
| Rollback story         | whatever the model does next       | refuse, re-plan, verify             |
| Good at                | reading, exploring, one-shot calls | changing state safely               |

**Use MCP for tool access. Use DSP for safe state change.** A useful agent will
have both: MCP to look around, DSP to alter anything that matters.

### A bridge design

Not implemented in 0.1. If you build one, expose **five** tools and no more:

| Tool           | Maps to                                 | Returns                             |
| -------------- | --------------------------------------- | ----------------------------------- |
| `dsp_discover` | `GET /.well-known/dsp`, `GET /v1/kinds` | what the runtime can make true      |
| `dsp_validate` | `POST /v1/validate`                     | `{valid, errors, warnings}`         |
| `dsp_plan`     | `POST /v1/plans`                        | the plan, redacted                  |
| `dsp_apply`    | `POST /v1/plans/{id}/apply`             | the operation with its verification |
| `dsp_status`   | `GET /v1/operations/{id}`               | the operation                       |

Constraints that keep the bridge from becoming the hole in the wall:

- **`dsp_apply` takes a plan id.** Never a document, under any parameter name. If the
  bridge accepts a document at apply time, it has re-created the problem DSP exists
  to solve.
- **No `dsp_approve` tool.** Approval is the human's decision. A bridge that lets the
  model approve its own plan has removed the only step the model is not allowed to
  take. Route approval to a person — a link, a chat prompt, a CLI.
- **The bridge holds no credentials.** It forwards a bearer token it was configured
  with; the runtime holds the provider credentials.
- **Pass the plan through unchanged.** Do not summarize it. The hash and the diff are
  the reviewable artifact; a summary is not.
- Set `X-DSP-Actor-Type: agent` and a stable `X-DSP-Actor-Id` so the audit log
  distinguishes the agent from a human.

That is five tool descriptions in the model's context instead of one per operation
per service — which is the token argument, stated concretely.

## The token-cost argument, honestly

DSP reduces model turns because the plan is computed by code rather than assembled a
tool call at a time. For an N-step change:

|                               | Tool calling                        | DSP                              |
| ----------------------------- | ----------------------------------- | -------------------------------- |
| Model turns                   | roughly one per step, plus recovery | one document, then read one plan |
| Tool descriptions in context  | one per operation per service       | five, or none over HTTP          |
| Re-reading state              | each time the model needs it        | once, by the runtime             |
| Recovery from partial failure | model reconstructs what happened    | re-plan; only the gap remains    |

Three qualifications, because the unqualified version is marketing:

1. **It only pays off with several interdependent steps.** For a single call, DSP is
   strictly more work: a document, a plan, a review, an apply.
2. **The saving is on the model, not on the system.** The runtime now reads current
   state, normalizes it, diffs it, scores it, evaluates policy and verifies
   afterwards. That is real compute — it is just deterministic, testable and cheap
   compute instead of tokens.
3. **The review step is a cost too.** A plan that needs human approval is slower than
   a tool call that does not. That is the point, and it should be chosen
   deliberately: policy decides what needs a human.

The reason to adopt DSP is not the token bill. It is that the change is reviewable
before it happens and verified after.

## CI/CD

The CLI is designed for this. Exit codes are stable, so a pipeline can branch on them
without parsing output.

```yaml
# Plan on every pull request, apply only on the default branch.
- name: DSP plan
  run: |
    node apps/cli/dist/main.js --json plan \
      --file infra/desired-state.yaml > plan.json
  env:
    DSP_SERVER: ${{ secrets.DSP_SERVER }}
    DSP_TOKEN: ${{ secrets.DSP_TOKEN }}

- name: Comment the plan on the PR
  run: node scripts/comment-plan.js plan.json

- name: DSP apply
  if: github.ref == 'refs/heads/main'
  run: |
    PLAN_ID=$(node -e "console.log(require('./plan.json').metadata.id)")
    node apps/cli/dist/main.js apply "$PLAN_ID" --confirm \
      --idempotency-key "${{ github.sha }}"
```

| Exit | Meaning                     | Pipeline should                                         |
| ---- | --------------------------- | ------------------------------------------------------- |
| `0`  | success                     | continue                                                |
| `2`  | invalid document            | fail the build; the document is wrong                   |
| `3`  | approval required           | pause and notify a human                                |
| `4`  | policy denied               | fail the build; this change is not allowed              |
| `5`  | state drift                 | re-plan; someone changed the world                      |
| `6`  | desired state not satisfied | fail and investigate                                    |
| `7`  | plan expired                | re-plan                                                 |
| `8`  | not confirmed               | expected without `--confirm`; not an error in a dry run |
| `9`  | audit chain broken          | alert; treat as a security event                        |
| `1`  | anything else               | fail                                                    |

Two practices worth adopting:

- **Use the commit SHA as the idempotency key.** A re-run of the same pipeline then
  returns the existing operation instead of applying twice.
- **Run `dsp audit verify` on a schedule**, not only in the deploy job. A broken
  chain is worth knowing about even when nobody is deploying.

`plan` in a pull request is a genuine dry run: `validate`, `inspect` and `plan`
perform no external change, so it is safe on every push.

## How an agent should use DSP

The intended loop, and the reason each step exists:

1. **Discover once.** Read the manifest and the kind schemas. Cache them; they change
   when the runtime is redeployed, not per request.
2. **Describe the end state.** Write a document, not a sequence. If you find yourself
   wanting ordering, express it as `dependsOn` in the provider, not as separate calls.
3. **Validate before planning.** It is cheap and the error paths are precise.
4. **Read the plan.** Not the summary — the changes. `summary.blocked` non-zero means
   part of the intent is unreachable. `executable: false` means it will never apply.
5. **Escalate when approval is required.** Do not attempt to work around it. Show the
   human the plan and the hash.
6. **Apply with a stable idempotency key.** Derive it from something that identifies
   the attempt, so a retry is a retry rather than a second change.
7. **Read the verification.** `completed` plus `satisfied` is the only combination
   that means the world matches the intent.
8. **On drift or expiry, re-plan.** Never retry a stale plan; the runtime will refuse
   it, and the refusal is correct.

The one thing an agent must not do is treat a refusal as an obstacle to route around.
`APPROVAL_REQUIRED`, `POLICY_DENIED` and `STATE_DRIFT_DETECTED` are the protocol
working.

## Other integration surfaces

| Surface                             | Status          | Notes                                                               |
| ----------------------------------- | --------------- | ------------------------------------------------------------------- |
| HTTP                                | implemented     | the primary transport; see [protocol.md](protocol.md)               |
| CLI                                 | implemented     | `dsp`, 11 commands, stable exit codes                               |
| Desired State file                  | implemented     | YAML or JSON, the unit of intent                                    |
| TypeScript client                   | partial         | `DspClient` in `apps/cli/src/client.ts` is usable but not published |
| MCP bridge                          | not implemented | design above; v0.3                                                  |
| IDE extension                       | not implemented | would wrap `plan` and render the diff                               |
| Web dashboard                       | not implemented | v0.2, primarily for remote approval                                 |
| Client libraries in other languages | not implemented | v0.3; the protocol is HTTP plus five schemas, so a client is small  |
