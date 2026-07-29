# Deploying DSP

Three things can be deployed, and they are not equally advisable.

| What                | Where                  | Status                                                                                                    |
| ------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Documentation site  | GitHub Pages           | live at [huliichuk.github.io/desired-state-protocol](https://huliichuk.github.io/desired-state-protocol/) |
| Local runtime       | your machine or Docker | one command, see below                                                                                    |
| Public demo runtime | Fly.io                 | config ready, needs an account                                                                            |

## Why not a serverless platform

DSP is a long-lived stateful process. Plans, approvals, operations, idempotency
keys and the audit chain live in SQLite on disk, and every one of them has to
outlive a single request:

- an **idempotency key** only prevents a duplicate apply if the record of the
  first apply is still there
- **drift detection** compares against the revision stored with the plan
- the **audit chain** is worthless if it restarts empty

A serverless function has no durable filesystem and no stable identity between
invocations, so all three guarantees would quietly stop holding. That rules out
Vercel Functions, Cloudflare Workers and Lambda for the runtime itself, and it is
why the documentation site — which _is_ static — is the part that goes to a CDN.

A hosted DSP runtime needs: a long-running process, a persistent volume, and TLS
in front of it.

## Running it locally

Nothing to deploy. Docker:

```bash
export DSP_AUTH_TOKEN=$(openssl rand -base64 32)
docker compose up --build
```

Or straight from source:

```bash
pnpm install && pnpm build
DSP_POLICY_DIR=examples/mock-workspace/policies node apps/server/dist/main.js
```

With `DSP_AUTH_TOKEN` unset, the server generates a token for that process and
prints it. See [docs/operations.md](../docs/operations.md) for the full
environment reference.

## A public demo runtime on Fly.io

[`fly/fly.toml`](fly/fly.toml) is ready. Four commands:

```bash
brew install flyctl && fly auth login
```

```bash
fly launch --config deploy/fly/fly.toml --copy-config --no-deploy
```

```bash
fly secrets set DSP_AUTH_TOKEN="$(openssl rand -base64 32)" --config deploy/fly/fly.toml
```

```bash
fly deploy --config deploy/fly/fly.toml
```

Fly terminates TLS for you, `force_https` is on, and the `[[mounts]]` volume keeps
the audit chain across restarts. `min_machines_running = 0` lets the demo sleep
when nobody is using it.

### Before you expose one

[SECURITY.md](../SECURITY.md) says not to point a DSP runtime at production
credentials, and a public demo is exactly where that rule gets broken by accident.
The config is written so it cannot be:

- **Only the mock provider is compiled in.** The "external system" this runtime can
  change is a SQLite file inside its own container. There is no real service
  reachable from it and no real credential to leak.
- **`DSP_ALLOW_DESTRUCTIVE=false`.** Deletions and replacements stay refused. Do not
  turn this on for something public.
- **`DSP_ENVIRONMENT=demo`.** The environment feeds the risk score, so demo plans
  stay out of the production risk band — and it is honest about what the thing is.
- **A real token, set as a Fly secret.** Not baked into the image, not committed.

If you publish the demo token so people can try it without asking you, understand
what you are publishing: anyone can create and apply plans against that container's
own database. That is acceptable for a mock provider and unacceptable the moment a
real provider is added.

Once a provider that talks to a real service exists, a public demo needs a
different shape: per-visitor tokens, that vendor's sandbox mode only, and rate
limiting. None of that is implemented in 0.1.

## Checking a deployment

```bash
curl -sf https://<your-host>/health
```

```bash
curl -sf https://<your-host>/.well-known/dsp
```

Both are reachable without a token, by design: a client has to be able to discover
how to authenticate. Everything else returns `401 UNAUTHORIZED` in the standard DSP
error envelope.

Then walk the lifecycle with the CLI:

```bash
DSP_SERVER=https://<your-host> DSP_TOKEN=<token> node apps/cli/dist/main.js discover
```

## The documentation site

Built from the repository's own markdown by
[`scripts/build-docs.mjs`](../scripts/build-docs.mjs) and deployed by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on every push to
`main` that touches a document.

Links to documents resolve inside the site; links to code resolve back to GitHub.
The markdown stays the single source, so there is no second copy to keep in sync.

Build it locally:

```bash
pnpm docs:build && npx http-server site
```
