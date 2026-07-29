# Deploying DSP

Two things can be deployed, and they have opposite requirements.

| What               | Where                                      | Status                                                                                                    |
| ------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Documentation site | GitHub Pages                               | live at [huliichuk.github.io/desired-state-protocol](https://huliichuk.github.io/desired-state-protocol/) |
| Runtime            | a host that runs a long-lived Node process | run it yourself, see below                                                                                |

## Why the runtime cannot go to a serverless platform

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

## Running it

Requires **Node.js 22 or newer**. The runtime uses the built-in `node:sqlite`, so
there is nothing to compile and no native module to install.

```bash
pnpm install && pnpm build
```

```bash
DSP_POLICY_DIR=examples/mock-workspace/policies node apps/server/dist/main.js
```

With `DSP_AUTH_TOKEN` unset the server generates a token for that process and prints
it, which is convenient locally and useless anywhere else — set it explicitly
wherever the process is not a terminal you are watching:

```bash
export DSP_AUTH_TOKEN=$(openssl rand -base64 32)
```

See [docs/operations.md](../docs/operations.md) for the full environment reference.

## Hosting it somewhere

A hosted DSP runtime needs four things:

1. **Node.js 22 or newer.**
2. **A long-running process**, restarted on failure.
3. **A writable directory that survives a restart**, for `DSP_DATABASE`. Losing it
   loses the audit trail.
4. **TLS in front of it.** DSP 0.1 serves plain HTTP.

Anything that provides those works: a VM with systemd, a managed Node host that
builds from source, or your existing process supervisor.

A systemd unit, as a concrete example:

```ini
[Unit]
Description=DSP runtime
After=network-online.target

[Service]
Type=simple
User=dsp
WorkingDirectory=/opt/dsp
ExecStart=/usr/bin/node apps/server/dist/main.js
Restart=on-failure
RestartSec=5

Environment=DSP_HOST=127.0.0.1
Environment=DSP_PORT=4040
Environment=DSP_ENVIRONMENT=production
Environment=DSP_DATABASE=/var/lib/dsp/runtime.sqlite
Environment=DSP_POLICY_DIR=/etc/dsp/policies
# Never inline the token. Point at a file only this user can read.
EnvironmentFile=/etc/dsp/secrets.env

# The runtime needs exactly one writable path.
ReadWritePaths=/var/lib/dsp
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Bind to `127.0.0.1` and put a reverse proxy in front of it for TLS, rather than
exposing the runtime directly.

### Before you expose one

[SECURITY.md](../SECURITY.md) says not to point a DSP runtime at production
credentials, and a publicly reachable runtime is where that rule gets broken by
accident. Before it is reachable by anyone but you:

- **Set `DSP_AUTH_TOKEN` to a high-entropy value.** A generated per-process token
  printed to stdout is not a deployment credential.
- **Leave `DSP_ALLOW_DESTRUCTIVE` unset.** Deletions and replacements stay refused.
- **Point `DSP_POLICY_DIR` at a reviewed bundle.** The built-in default blocks
  destructive changes and requires approval for high risk, and nothing more.
- **Give provider credentials the minimum scope** the declared resource types need.
- **Name the environment honestly.** `DSP_ENVIRONMENT` feeds the risk score, so
  calling production `production` is what makes production plans score as risky.

Only the reference provider ships in 0.1, and the "external system" it can change is
a SQLite file beside the runtime. The moment a provider that talks to a real service
is added, a publicly reachable runtime needs per-caller tokens, that vendor's sandbox
mode, and rate limiting — none of which exists yet.

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

The social preview card is regenerated separately, because the site builds on a CI
runner with no browser:

```bash
pnpm docs:og
```
