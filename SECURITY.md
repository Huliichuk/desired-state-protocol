# Security Policy

## Pre-1.0 warning

DSP `0.1.0` has **not had an external security review**. It is a reference
implementation of a young protocol.

Do not point a DSP runtime at production credentials yet. Use provider credentials
scoped to a test or sandbox account, and treat the runtime as you would any other
component with write access to your systems.

The design intent is that an agent can never obtain a credential or perform an
unreviewed change. The implementation is tested against that intent
([docs/security.md](docs/security.md) documents the mechanisms and the known gaps),
but "tested" is not "audited".

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately first. Include:

- what you found, and which files or endpoints are involved
- how to reproduce it, ideally as a failing test
- what an attacker gains
- the commit or version you tested

You will get an acknowledgement within 3 working days and an assessment within 10.
We aim to ship a fix before public disclosure, and follow a **90-day coordinated
disclosure window** from the acknowledgement date. If a fix will take longer we
will say so and agree a date with you rather than let the window lapse silently.

Credit is given by default; tell us if you would rather not be named.

## In scope

- bypassing the plan gate: causing an external change without an approved,
  hash-matching, unexpired plan
- causing `apply` to execute something the reviewed plan did not contain
- extracting a credential through any surface: plans, audit events, HTTP responses,
  error details, logs, CLI output
- defeating an approval requirement, or reusing an approval across plans or windows
- forging or silently rewriting audit history
- making the plan hash non-deterministic, or making two different change sets hash
  the same
- escaping the scoped secret resolver from inside a provider
- SSRF through a Desired State document
- denial of service through document size, nesting, resource count or change count
- authentication bypass on any non-public endpoint

## Out of scope

- findings that require an attacker who already controls the runtime process or its
  database (the audit chain is tamper-**evident**, not tamper-proof, and this is
  documented, not a defect)
- the absence of features 0.1 explicitly does not implement: multi-tenancy
  isolation, OAuth, signed provider manifests, compensation and rollback
- vulnerabilities in the `node:sqlite` experimental API itself — report those
  upstream to Node.js; tell us if DSP's use of it makes something exploitable
- missing rate limits on a runtime that is, by design, bound to `127.0.0.1` by
  default
- results from automated scanners without a demonstrated impact

## Supported versions

| Version | Supported                          |
| ------- | ---------------------------------- |
| `0.1.x` | yes — the current development line |
| earlier | none; there are none               |

Pre-1.0, fixes land on the development line. There are no backports.

## Hardening a deployment

Before exposing a runtime beyond localhost:

1. Set `DSP_AUTH_TOKEN` explicitly to a high-entropy value. An unset token makes
   the server generate one per process and print it, which is convenient for
   development and useless for deployment.
2. Use `DSP_SECRET_STORE=encrypted-file` with a 32-byte `DSP_SECRET_MASTER_KEY`
   kept outside the repository, or supply secrets through the environment store.
3. Point `DSP_POLICY_DIR` at a reviewed policy bundle. The default bundle blocks
   destructive changes and requires approval for high risk, and nothing more.
4. Leave `DSP_ALLOW_DESTRUCTIVE` unset.
5. Give provider credentials the minimum scope that makes the declared resource
   types work.
6. Terminate TLS in front of the runtime. DSP 0.1 serves plain HTTP.
7. Back up the runtime database and verify the audit chain regularly with
   `dsp audit verify`.

See [docs/operations.md](docs/operations.md) for the full environment reference.
