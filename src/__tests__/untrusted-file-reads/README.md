# Untrusted File Reads

A repository can make git open a file that never ends (`/dev/zero`) or that
blocks on open (a FIFO inside the repository) without any symbolic link,
external program or hook. Unhandled, every panel command hangs until the host
timeout (30 s; reading `/dev/zero` also grows the git process to tens of GB),
and auto-refresh retries with backoff. Each plugin git command must instead
finish in normal time (asserted: under 3 s each) with correct results.
Verified with real git 2.50.1 and 2.56.1.

- UF1: `[diff] orderFile = /dev/zero` — `status` (fingerprint and list),
  `diff --numstat HEAD`, `diff -- <path>`, `diff --cached`, `log -1`, `add`
  and `commit` all finish and show the right content; the repository stays
  trusted. Neutralised by `-c diff.orderFile=/dev/null` on every command
  (`exec` T14; an empty value is rejected by git).
- UF2: the same with `orderFile` pointing at a FIFO. UF2b: a FIFO inside the
  git directory is itself a reason to restrict (UF4).
- UF3: `mailmap.file = /dev/zero`, `mailmap.file = <FIFO>`, or a FIFO named
  `.mailmap` at the top of the working tree — reading the HEAD message
  (`log -1`: amend prefill, post-commit summary) finishes. Neutralised by
  `--no-mailmap` on `log` / `show`.

- UF4: a FIFO at `.git/info/exclude`, `info/attributes`, `packed-refs`,
  `info/grafts`, `shallow`, `info/sparse-checkout`,
  `objects/info/commit-graph`, `COMMIT_EDITMSG` or `index` — the repository
  is restricted at once (`unsafe-layout`, the message names the file) and no
  `status` runs. Generally: any entry in the scanned part of the git
  directory that is not a regular file, directory or link (`repo-safety`
  S8).
- UF5: a FIFO `.gitignore` / `.gitattributes` at the top of the working tree —
  restricted the same way. Ones in subdirectories are not checked (git reads
  one per directory; checking would walk the whole tree): known residual.
- UF6: a special file named `fsmonitor--daemon.ipc` at the top of the git
  directory (git's own fsmonitor socket; `core.fsmonitor` is pinned off, git
  never opens it) leaves the repository trusted and the panel working.
- UF7: the real plugin's refresh on such a repository finishes in normal time,
  `repoRoot` stays null and the store carries the restriction the panel shows.
- UF8: `include.path` naming a FIFO blocks the config probe itself; it times
  out (5 s) and the repository is restricted (`probe-failed`) with no other
  git command run.

The full list of path-valued config keys and how each is handled is in
`doc/git-config-classification.md` ("Keys that name a file").
