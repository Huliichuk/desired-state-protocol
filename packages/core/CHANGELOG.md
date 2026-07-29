# @dsp/core

## 0.1.2

### Patch Changes

- Updated dependencies [6b01211]
  - @dsp/protocol@0.1.2
  - @dsp/audit@0.1.2
  - @dsp/execution-engine@0.1.2
  - @dsp/plan-engine@0.1.2
  - @dsp/policy-engine@0.1.2
  - @dsp/provider-sdk@0.1.2
  - @dsp/secret-store@0.1.2
  - @dsp/verification-engine@0.1.2

## 0.1.1

### Patch Changes

- f4eed6b: Report the running build's real version in the DSP manifest.

  `server.version` was a literal `'0.1.0'` written in two places, so the manifest
  would have kept claiming 0.1.0 after every release. It is the field a client reads
  to identify what it is talking to, so it now comes from `package.json` at runtime,
  and a test asserts it.
  - @dsp/protocol@0.1.1
  - @dsp/plan-engine@0.1.1
  - @dsp/policy-engine@0.1.1
  - @dsp/execution-engine@0.1.1
  - @dsp/verification-engine@0.1.1
  - @dsp/audit@0.1.1
  - @dsp/secret-store@0.1.1
  - @dsp/provider-sdk@0.1.1
