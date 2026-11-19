# Git Exec Wrapper

Every git call goes through `gitExec` (plugin shell SDK). It hardens each
invocation against executable settings in an untrusted repository config:

- Global options: `--no-optional-locks --no-pager` and the pinned config
  (`PINNED_CONFIG`, each as `-c key=value`, which outranks repository config):
  `core.fsmonitor=false`, `log.showSignature=false`, `submodule.recurse=false`,
  `diff.submodule=short`, `status.submoduleSummary=false` (no git command may
  spawn a process inside a nested repository / submodule — that process would
  read the nested repository's own, uninspected config), `maintenance.auto=false`
  and `gc.auto=0` (a plugin commit does not start background maintenance), plus
  `-c protocol.allow=never` for every command except a commit whose repository
  hooks the user confirmed (hooks inherit `-c` values and env and may
  legitimately fetch), and `-c core.hooksPath=/dev/null` for every command
  except `commit`: index / worktree writers (`add`, `apply --cached`,
  `restore`, `reset`, `checkout`) otherwise run `post-index-change` /
  `post-checkout` hooks planted in an untrusted `.git/hooks`. `commit` keeps
  hooks (see `commit-hooks-confirm`).
- Config-defined hooks (git ≥ 2.54: `hook.<name>.command` + `hook.<name>.event`)
  do not live in the hooks directory, so `core.hooksPath` has no effect on
  them. Every command except `commit` therefore also carries
  `-c hook.<event>.enabled=false` for each event of githooks(5)
  (`KNOWN_HOOK_EVENTS`; the per-event switch exists since git 2.55 and turns
  off configured and directory hooks alike — git has no single switch or
  environment variable for all of them). This keeps "no hook runs for anything
  but commit" true for the user's own global / system configured hooks;
  repository-scope `hook.*` keys are restricted outright (`repo-safety`). On
  git 2.54 the switch does not exist yet and the arguments are inert.
- Output pins (`PINNED_OUTPUT_CONFIG`, every command except `commit`, whose
  output is not parsed and whose `-c` values reach hooks): `status.renames=true`,
  `diff.renames=true` (the file list must not change shape with repository
  config), `color.ui=false`, `color.diff=false`, `diff.noprefix=false`,
  `diff.mnemonicPrefix=false`, `diff.srcPrefix=a/`, `diff.dstPrefix=b/`,
  `diff.context=3`, `diff.interHunkContext=0`, `diff.suppressBlankEmpty=false`,
  `diff.relative=false` (hunk patches are generated from this output),
  `i18n.logOutputEncoding=UTF-8`, `apply.ignoreWhitespace=no`. Always pinned:
  `core.protectHFS=true`, `core.protectNTFS=true`, `i18n.commitEncoding=UTF-8`,
  `diff.orderFile=/dev/null` (status / diff / commit open and read the order
  file to the end — `/dev/zero` or a FIFO hung every command until the host
  timeout; an empty value makes git fail; T14, `untrusted-file-reads`).
- Per subcommand: `diff` → `--no-ext-diff --no-textconv --ignore-submodules=dirty
  --submodule=short`; `show` / `log` → `--no-ext-diff --no-textconv
  --no-show-signature --submodule=short --no-mailmap` (log reads
  `mailmap.file` / `mailmap.blob` / `.mailmap` at start-up; T14); `status` → `--ignore-submodules=dirty`
  (no recursion into nested repos whose config is not inspected; it has to be
  the flag — `submodule.<name>.ignore` outranks `-c diff.ignoreSubmodules`);
  `commit` → `--quiet` (the change summary would read old blobs, which in a
  partial clone triggers a lazy fetch — or, with the network blocked, makes a
  commit that was created exit 128).
- Env: `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=:`, and
  (except a hooks-confirmed `commit`) `GIT_NO_LAZY_FETCH=1` plus
  `GIT_ALLOW_PROTOCOL=` (empty list): a repository `protocol.<name>.allow=always` outranks
  `-c protocol.allow=never`, but no config can override the env variable.
- Env, every command except `commit`: `GIT_LITERAL_PATHSPECS=1` (with the
  other global pathspec variables forced to 0, which git requires). Paths come
  verbatim from `git status`; as pathspecs a file named `*`, `:(glob)**` or
  `[id].tsx` would make "stage / discard this file" hit other files. Not set
  for `commit` (no path arguments, and its env reaches hooks that use globs).
- Arguments are passed byte for byte: `-c core.precomposeUnicode=false`
  (`LITERAL_ARGV_CONFIG`) on every command except `status`, `commit` and an
  `add` of an untracked path (`untrackedPathArgs`). On macOS a repository
  config `core.precomposeUnicode=true` makes git rewrite arguments to NFC, so
  an index entry with an NFD name (reported verbatim by `status`) could not be
  addressed. `status` and the untracked `add` keep the repository setting
  because they depend on directory names being converted the same way; `commit`
  takes no paths and its `-c` values reach hooks.
- An app shell may carry a guard (see `repo-safety`); a refusal or a guard error
  returns a failed result (exit 128) and git is not spawned (fail-closed).

T1 status argv + env. T2 caller env preserved, hardening values win. T3 diff/show/log
flags. T3b nested-repository pins/flags on every subcommand. T4 commit keeps hooks enabled, `--quiet`, network blocked unless `repoHooksConfirmed`. T4b the option affects commit only. T5 guard refusal skips spawn.
T6 throwing guard fails closed. T7 passing guard runs the hardened command. T8 every non-commit subcommand disables hooks. T8b … and switches off every hook event; commit carries no `hook.*` argument.
T9 `GIT_ALLOW_PROTOCOL` is empty (caller env cannot re-enable it) and unset only for a hooks-confirmed commit.
T11 literal pathspecs for every non-commit call. T12 output pins. T10 `stripTrailingNewline` (used for path-valued git output instead of `trim()`) removes one trailing LF/CRLF only.
T13 `core.precomposeUnicode=false` on every index-path command, absent from status / untracked add / commit. T13b `gitExec` forwards `untrackedPathArgs` to the argument builder only.
