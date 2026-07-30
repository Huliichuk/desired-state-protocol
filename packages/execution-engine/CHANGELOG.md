# @dsp/execution-engine

## 0.4.0

### Patch Changes

- Updated dependencies [9ec39b5]
  - @dsp/protocol@0.4.0
  - @dsp/provider-sdk@0.4.0

## 0.3.0

### Patch Changes

- c813e70: Add a Stripe provider for products and prices, and fix the bug it found.

  The reference provider was written by the same author as the runtime, so it cannot
  falsify the runtime's design. Stripe's rules were not: a price cannot be deleted at
  all, and after creation only `metadata`, `nickname` and `active` can be updated. The
  test transport enforces those rules rather than agreeing with the provider, so a
  wrong DSP design gets rejected instead of accepted.

  The abstraction held. `immutableFields` expresses what Stripe fixes at creation, so
  raising a price on the same lookup key becomes a blocked replace with the old value
  still visible; `dependsOn` orders product before price with no sequencing code; and
  the workflow Stripe actually intends — a new price under a new lookup key, the old
  one archived — plans as one create and one update.

  It also found a real bug in the executor, fixed here: a dependency was only
  considered met when it had `succeeded`, so a `noop` parent skipped its children.
  Adding a price to an existing product, a table to an existing database, or a record
  to an existing zone silently did nothing and reported the dependency as unmet. A
  `noop` means the resource is already in the desired state, which is exactly what a
  dependency asks for. SPEC.md §16 stated the wrong rule too and now states this one.

  The executor had no direct tests — it was only exercised through the runtime, whose
  scenarios never added a child under an existing parent. It has them now.
  - @dsp/protocol@0.3.0
  - @dsp/provider-sdk@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [abeead5]
  - @dsp/protocol@0.2.0
  - @dsp/provider-sdk@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [6b01211]
  - @dsp/protocol@0.1.2
  - @dsp/provider-sdk@0.1.2

## 0.1.1

### Patch Changes

- @dsp/protocol@0.1.1
- @dsp/provider-sdk@0.1.1
