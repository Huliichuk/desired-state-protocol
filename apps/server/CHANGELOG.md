# @dsp/server

## 0.4.0

### Patch Changes

- Updated dependencies [9ec39b5]
  - @dsp/protocol@0.4.0
  - @dsp/provider-mock@0.4.0
  - @dsp/audit@0.4.0
  - @dsp/core@0.4.0
  - @dsp/policy-engine@0.4.0
  - @dsp/provider-sdk@0.4.0
  - @dsp/secret-store@0.4.0

## 0.3.0

### Patch Changes

- @dsp/core@0.3.0
- @dsp/protocol@0.3.0
- @dsp/policy-engine@0.3.0
- @dsp/audit@0.3.0
- @dsp/secret-store@0.3.0
- @dsp/provider-sdk@0.3.0
- @dsp/provider-mock@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [abeead5]
- Updated dependencies [abeead5]
  - @dsp/protocol@0.2.0
  - @dsp/secret-store@0.2.0
  - @dsp/audit@0.2.0
  - @dsp/core@0.2.0
  - @dsp/policy-engine@0.2.0
  - @dsp/provider-mock@0.2.0
  - @dsp/provider-sdk@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [a73eded]
- Updated dependencies [6b01211]
  - @dsp/provider-mock@0.1.2
  - @dsp/protocol@0.1.2
  - @dsp/audit@0.1.2
  - @dsp/core@0.1.2
  - @dsp/policy-engine@0.1.2
  - @dsp/provider-sdk@0.1.2
  - @dsp/secret-store@0.1.2

## 0.1.1

### Patch Changes

- f4eed6b: Report the running build's real version in the DSP manifest.

  `server.version` was a literal `'0.1.0'` written in two places, so the manifest
  would have kept claiming 0.1.0 after every release. It is the field a client reads
  to identify what it is talking to, so it now comes from `package.json` at runtime,
  and a test asserts it.

- Updated dependencies [f4eed6b]
  - @dsp/core@0.1.1
  - @dsp/protocol@0.1.1
  - @dsp/policy-engine@0.1.1
  - @dsp/audit@0.1.1
  - @dsp/secret-store@0.1.1
  - @dsp/provider-sdk@0.1.1
  - @dsp/provider-mock@0.1.1
