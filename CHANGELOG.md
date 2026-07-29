# Changelog

Every release is published at
[github.com/Huliichuk/desired-state-protocol/releases](https://github.com/Huliichuk/desired-state-protocol/releases),
with notes assembled from the changesets that went into it.

Each `@dsp/*` package also keeps its own `CHANGELOG.md`, written by
[Changesets](https://github.com/changesets/changesets). Those are the detail; the
releases are the summary.

## Two versions, on purpose

| Version          | Where                                                               | Changes when                              |
| ---------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| Package version  | every `@dsp/*` `package.json`, and `server.version` in the manifest | any release: a fix, a feature, a refactor |
| Protocol version | `DSP_PROTOCOL_VERSION`, and `protocolVersion` in the manifest       | only when the wire format changes         |

They are deliberately not coupled. A client reads `protocolVersion` to decide
whether it can talk to a runtime at all, so bumping it for an internal bug fix
would tell every client to re-check compatibility for no reason.

All `@dsp/*` packages are version-locked and move together, so one version
describes the whole repository and one tag — `v<version>` — marks each release.

## How a change reaches a release

1. A pull request that touches a released package includes a changeset
   (`pnpm changeset`). CI fails without one.
2. Merging to `main` opens or updates a **Version packages** pull request that
   bumps every version and writes the changelogs.
3. Merging that pull request tags `v<version>` and publishes a GitHub release.

Nothing is versioned unless it builds and its tests pass — the release workflow
runs both before it touches a version.

See [CONTRIBUTING.md](CONTRIBUTING.md#versioning-and-releases) for the details.

## 0.1.0

The first release: DSP `0.1.0` (`dsp.dev/v1alpha1`).

A complete runtime with the reference provider — protocol types, canonical JSON
and hashing, the published JSON Schemas, a deterministic diff and risk model, a
declarative policy engine, plan execution with retries and timeouts, mandatory
verification, a hash-chained audit log, scoped secret resolution, an HTTP surface
with an OpenAPI description, and the `dsp` command line client.

The Stripe provider is not implemented. Deletions and replacements are refused by
default.
