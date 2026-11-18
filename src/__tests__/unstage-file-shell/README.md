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

Entries below the path. `git restore --staged -- x` and the `git reset HEAD --
x` fallback treat `x` as a prefix. With `D  x` and `AM x/work.txt` staged (a
file replaced by a directory, staged as a whole, then edited again),
unstaging the `x` row also unstaged `x/work.txt` and dropped its staged
version. `unstageFile` first asks the index (`ls-files -s -z -- <path>`,
read-only) whether entries exist inside `<path>/` and refuses if so, or if the
query fails (fail-closed).

- T9: entries inside `<path>/` (any stage) → refused before anything else
  runs.
- T10: the path's own record, no record, or names that only share the first
  letters do not block; a failed / timed-out / truncated query refuses.

Real git: `repo-safety-real-git` R79.

The other directions of the same prefix problem. The index cannot hold `x`
and `x/…` at once.

- An ancestor of the path is an index entry: with a folder replaced by a file
  and staged (`AM x`, `D  x/a`), unstaging the `x/a` row puts `x/a` back and
  drops the entry `x` — the staged version of `x` is gone. Each ancestor is
  asked on its own (`ls-files -s -z -- <ancestor>`); the index is sorted, so
  the ancestor's own record, if any, is the first one, and only that record is
  read (small output cap; a cut after it is not a failure).
- The path is a folder in HEAD: unstaging `A  x` restores every `x/…` entry
  from HEAD, i.e. unstages the `D  x/a` rows too (`ls-tree -z HEAD -- <path>`).
  With no commit yet there is nothing in HEAD and the check passes.

Neither case can be untangled row by row (each blocks the other), so the
messages point to a terminal.

- T11: an ancestor entry at any depth and any stage → refused, naming it.
- T12: a folder ancestor does not block, however long its listing; failed /
  timed-out queries and a cut or unreadable first record refuse; a top-level
  path asks nothing.
- T13: a tree in HEAD → refused; blob / gitlink / nothing → unstaged; unborn
  HEAD → unstaged; anything unanswerable refuses.

Real git: `repo-safety-real-git` R85, R86, R86b.
