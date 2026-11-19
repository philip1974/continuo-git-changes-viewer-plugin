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
- UF2: the same with `orderFile` pointing at a FIFO inside the repository.
- UF3: `mailmap.file = /dev/zero`, `mailmap.file = <FIFO>`, or a FIFO named
  `.mailmap` at the top of the working tree — reading the HEAD message
  (`log -1`: amend prefill, post-commit summary) finishes. Neutralised by
  `--no-mailmap` on `log` / `show`.

The full list of path-valued config keys and how each is handled is in
`doc/git-config-classification.md` ("Keys that name a file").
