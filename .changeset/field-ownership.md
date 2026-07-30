---
'@dsp/protocol': minor
'@dsp/provider-mock': minor
---

Add field ownership.

A document said what should be true. It had no way to say what it was _responsible
for_, and the gap was invisible in three measured ways.

The specification defined the diff — which fields differ — but never said what an
`update` does with them. A provider that replaced an attribute set and one that
merged into it were both conforming and produced different worlds from the same
document change, and verification could not see the difference because it only checks
declared paths. `SPEC.md` §8.3.1 now requires an update to set the declared paths and
leave every other observed attribute alone. The reference provider replaced; it now
merges.

A field declared once and then dropped kept whatever value it had, with no record
that nobody was managing it. A plan now reports the release, names the owner giving it
up, and the value is deliberately left in place: removing a value is a separate act,
expressed by declaring the removal.

Two documents over one resource each read the other's value as drift and fought,
silently, last apply winning. A change that declares a path another document owns is
now `blocked` with `FIELD_OWNERSHIP_CONFLICT`, the current owner named in the reason,
and `before`/`after` preserved so a reviewer sees both the intent and the obstacle.

Claims are keyed by scope — the provider plus the `resourceId` its inspection
reported — because a resource key is only unique inside one document's world. Without
the scope the `main` database of two different workspaces looked like one contested
resource; this was caught by a demo that produced a false conflict before release.

Ownership is recorded by the runtime, not by a provider. The Stripe provider had to
invent its own marker in vendor metadata for want of this, and every provider talking
to a shared account would have invented a different one.

`PlanOwnership` is covered by the plan hash, and claims are re-checked immediately
before executing, so a plan built when a field was free cannot apply after another
document has taken it.
