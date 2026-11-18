# unstage-file-shell

BDD coverage for file-level unstage and restore capability caching.

Unstage uses `git restore --staged -- <path>` and falls back to `git reset HEAD
-- <path>` only when `restore` does not exist. Support is probed once with `git
restore -h`: git prints the usage and exits 129 before 2.5x and 0 on newer
versions (verified 2.50.1 / 2.56.1); a missing command exits 1.

- T5 / T5b: probe exit 0 or 129 → `restore --staged`.
- T6: probe exit 1 → `reset HEAD --`. T6b: timeout, signal or a guard refusal
  (128) is not taken as support.
- T7: the probe result is cached.

Real-git coverage: `repo-safety-real-git` R59.
