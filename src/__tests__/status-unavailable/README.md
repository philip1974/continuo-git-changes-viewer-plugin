# Status Unavailable

The file list comes from `git status --porcelain=v1 -z`. When that command
does not produce a complete, trustworthy list, the panel must say so instead
of looking like a clean working tree:

- non-zero exit (corrupt index, refused by the repository guard, …),
- timeout,
- output truncated by the host output limit (the list is incomplete).

Before, the scan returned an empty (or silently shortened) list. The panel then
showed "No staged changes" while **Amend** — which does not look at the staged
count (`can-amend`) — stayed enabled and would commit staged content the user
could not see.

Behavior:

- `scanStatus` rejects with `StatusUnavailableError`. Its message is `git
  status failed (<first stderr line, at most 200 characters | timed out | exit
  N>)` or `git status output was too large; the list of changes is
  incomplete`; `partial` holds the complete records read before a truncation
  (empty otherwise). A forged index still rejects with `UnsafeIndexError`.
- The plugin's refresh turns it into `statusError` on the store: the
  repository stays open (not restricted, `repoRoot` kept so Refresh and
  auto-refresh keep working), the list is empty — or the partial list after a
  truncation.
- A refresh that throws for any other reason also sets `statusError` (the
  previous list stays, but is of unknown age). The store no longer sets a
  dismissable banner for that; `onError` is still called.
- The next successful refresh clears `statusError`.
- While `statusError` is set the panel shows a non-dismissable alert — "Could
  not read the repository status: <reason>. Commit and Amend are disabled until
  a refresh succeeds." — and the commit button is disabled in both modes; the
  hint next to it reads "Status unavailable". A restriction alert takes
  precedence.

Specs:

- S1: non-zero exit → `StatusUnavailableError` with the first stderr line;
  numstat is not run.
- S2: timeout → "timed out"; no stderr → "exit N" / "exit unknown"; long
  stderr line cut at 200 characters.
- S3: truncated → error with the complete records in `partial`.
- S4: a successful status, empty or not, resolves as before.
- S5: `statusError` from the load result is stored and cleared by the next
  clean load.
- S6: a throwing refresh sets `statusError`, keeps the old list, calls
  `onError`; cleared on the next success.
- S7: `clear()` resets it.
- S8: plugin refresh with a failing status → `repoRoot` kept, no list, no
  restriction, `statusError` set; cleared after a good refresh.
- S9: plugin refresh with a truncated status → partial list + `statusError`.
- S10: panel alert text, not dismissable; Commit disabled with staged files and
  a message; hint "Status unavailable".
- S11: Amend disabled too; enabled again with a usable status.
- S12: a restriction alert takes precedence.

Real-git coverage: `repo-safety-real-git` R63–R63b.
