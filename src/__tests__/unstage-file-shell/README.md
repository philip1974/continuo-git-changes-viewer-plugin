# unstage-file-shell

BDD coverage for file-level unstage and restore capability caching.

Unstage uses `git restore --staged -- <path>` and falls back to `git reset HEAD
-- <path>` only when `restore` does not exist. Support is probed once with `git
restore -h`: git prints the usage and exits 129 before 2.5x and 0 on newer
versions (verified 2.50.1 / 2.56.1); a missing command exits 1.

Only definite answers are cached: 0 / 129 (supported) and 1 (no such command;
judged by exit code, the message is locale-dependent). A timeout, a signal, a
refusal by the repository guard (128) or any other exit code says nothing
about git — before, one such probe marked `restore` as unsupported for the
rest of the session. Those are not cached: that call uses the reset fallback
and the next call probes again.

- T5 / T5b: probe exit 0 or 129 → `restore --staged`.
- T6: probe exit 1 → `reset HEAD --`. T6b: timeout, signal or a guard refusal
  (128) is not taken as support.
- T6c: an inconclusive probe (timeout, timeout with exit 1, signal, 128, other
  exit code) is not cached — reset this time, a new probe next time, and once
  the probe answers `restore` is used and remembered.
- T6d: exit 1 is cached — later calls use reset without probing again.
- T7: a positive probe result is cached.

Real-git coverage: `repo-safety-real-git` R59.
