# Repo Safety (restricted repositories)

Opening a folder whose `.git` was written by someone else (an extracted
archive, a shared drive) must not let it harm the user when the viewer
automatically runs git. Such a repository has two kinds of leverage:

- **Execution** — local config makes git run programs. git has no switch to
  disable `filter.<drv>.clean` (it runs while `git status` re-hashes files).
- **Redirection** — nothing is executed, but git resolves the working tree, the
  git directory or the object store to somewhere outside the workspace, so
  status / diff display outside files (or another private repository) and
  stage / discard / commit write there.

Before any git command the plugin probes the repository in three steps; a
restricted verdict at one step skips the later ones.

1. **Config** — `git config --list --show-scope --includes -z` (reads config
   only, executes nothing).
   - Only `local` / `worktree` scope entries are inspected (including files
     pulled in via `include.path` / `includeIf`); global/system config is the
     user's own.
   - Executable keys (filter clean/smudge/process, diff textconv/command,
     diff.external, merge drivers, gpg programs, askpass, gitproxy,
     upload/receive pack, protocol.*.allow, trailer commands, git-lfs
     extensions/custom transfers, gc.recentObjectsHook, non-boolean
     core.fsmonitor, `diff.submodule` other than short/log) → restricted.
   - Redirect keys → restricted: `core.worktree` (any value) and `core.bare`
     unless false.
2. **Layout** (defense in depth, independent of the key list) — one
   `git rev-parse --path-format=absolute --is-inside-work-tree --show-prefix
   --absolute-git-dir --git-common-dir --show-toplevel`:
   - git itself must report that the workspace root is the top of the working
     tree (`true` + empty prefix). The comparison is done by git, so it is not
     confused by `/tmp` → `/private/tmp` or case-insensitive file systems.
     Subfolder of a repository, bare repository, redirected working tree →
     restricted.
   - the git directory and the common directory must both lie inside the
     toplevel. A linked worktree or submodule whose main repository lives
     outside the workspace is therefore restricted too: it cannot be told apart
     from a `.git` that points at the victim's other private repository.
   - output that is not exactly five lines (newline in a path, git < 2.31) or
     any other failure → restricted. A folder that is not inside any repository
     is not restricted (nothing to protect; detection reports it as before).
3. **Symbolic links inside the git directory** (`app.fs.listDir` / `lstat`, no
   process) — for the git directory and the common directory: any symbolic
   link among the top-level entries, anywhere under `refs` / `logs` / `info` /
   `reftable`, among the entries of `objects` (fan-out directories included),
   under `objects/info`, or in `objects/pack` → restricted. A non-empty
   `objects/info/alternates` → restricted. A symlinked top-level `hooks` is
   left to the pre-commit hooks check. If file access is unavailable, denied,
   or fails, the repository is restricted.

- Restricted (or probe failure) is fail-closed: every `gitExec` call on that
  repository returns a failed result without spawning git, and the panel shows
  a warning explaining why and how to recover.
- Not flagged on purpose: core.pager/editor (neutralized by `--no-pager` and
  `GIT_EDITOR=:`), network-only keys such as core.sshCommand / credential.helper
  and partial-clone settings (every command, including a commit whose hooks
  were not confirmed, runs with `protocol.allow=never` + `GIT_NO_LAZY_FETCH=1`
  + `GIT_ALLOW_PROTOCOL=`),
  core.hooksPath (hooks are disabled for everything but commit, which asks for
  confirmation), and keys that merely name an outside file that git parses as
  patterns without echoing it (core.excludesFile, core.attributesFile,
  diff.orderFile, mailmap.file) or that the plugin never uses
  (commit.template).
- The verdict is cached per repo root keyed by `.git/config` mtime+size
  (`app.fs.stat`, no process). No cache when stat is unavailable or the config
  uses includes; a layout / symlink restriction is never cached. Every panel
  refresh re-probes (`fresh: true`).

T1 output parsing. T2–T5 executable key classification (T4b diff.submodule). T18–T20 redirect keys.
T6–T9 config probe and fail-closed. L1–L7 layout probe. S1–S7 symlink scan.
T10–T15b cache. T16–T17 guard wiring into `gitExec`.
