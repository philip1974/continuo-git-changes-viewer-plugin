# commit-shell

BDD coverage for the v0.4.0 commit shell wrapper.

- T1: successful `git commit -F -` maps to `ok: true`.
- T2: failed commit maps to an error result.
- T3-T6: command shape uses `-F -`, stdin input, no optional locks, and 120s timeout.
- T7: a real temp repo preserves multi-line commit messages through stdin.
- T8: timeout formatting is explicit.
- T9-T10: reading the last commit subject succeeds or falls back to null.

