# Status Hash

Auto-refresh compares the raw porcelain status output before mutating the
viewer store, so unchanged working trees do not trigger refresh side effects.

- T6: readStatusHash returns raw porcelain stdout through the read-only git wrapper.
- T6b: a non-zero git status result throws.
