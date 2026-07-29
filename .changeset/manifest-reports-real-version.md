---
'@dsp/core': patch
'@dsp/server': patch
---

Report the running build's real version in the DSP manifest.

`server.version` was a literal `'0.1.0'` written in two places, so the manifest
would have kept claiming 0.1.0 after every release. It is the field a client reads
to identify what it is talking to, so it now comes from `package.json` at runtime,
and a test asserts it.
