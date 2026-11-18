# Repo Safety (restricted repositories)

Opening a folder whose `.git/config` was written by someone else (an extracted
archive, a shared drive) must not let that config run programs when the viewer
automatically runs git. git has no switch to disable `filter.<drv>.clean`
(it runs while `git status` re-hashes files), so before any git command the
plugin probes the repository-scope config read-only:

`git config --list --show-scope --includes -z` (reads config only, executes nothing).

- Only `local` / `worktree` scope entries are inspected (including files pulled
  in via `include.path` / `includeIf`); global/system config is the user's own.
- Executable keys (filter clean/smudge/process, diff textconv/command,
  diff.external, merge drivers, gpg programs, askpass, gitproxy, upload/receive
  pack, protocol.*.allow, trailer commands, git-lfs extensions/custom transfers,
  non-boolean core.fsmonitor) put the repository into the **restricted** state.
- Restricted (or probe failure, e.g. git < 2.26) is fail-closed: every `gitExec`
  call on that repository returns a failed result without spawning git, and
  the panel shows a warning explaining why and how to recover.
- Not flagged on purpose: core.pager/editor (neutralized by `--no-pager` and
  `GIT_EDITOR=:`), network-only keys such as core.sshCommand / credential.helper
  (read commands run with `protocol.allow=never` + `GIT_NO_LAZY_FETCH=1`), and
  core.hooksPath (hooks only run on user-initiated commit/discard, same trust
  model as running git in a terminal).
- The verdict is cached per repo root keyed by `.git/config` mtime+size
  (`app.fs.stat`, no process). No cache when stat is unavailable or the config
  uses includes. Every panel refresh re-probes (`fresh: true`).

T1 output parsing. T2–T5 key classification. T6–T9 probe and fail-closed.
T10–T15 cache. T16–T17 guard wiring into `gitExec`.
