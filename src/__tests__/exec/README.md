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
- Per subcommand: `diff` → `--no-ext-diff --no-textconv --ignore-submodules=dirty
  --submodule=short`; `show` / `log` → `--no-ext-diff --no-textconv
  --no-show-signature --submodule=short`; `status` → `--ignore-submodules=dirty`
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
- An app shell may carry a guard (see `repo-safety`); a refusal or a guard error
  returns a failed result (exit 128) and git is not spawned (fail-closed).

T1 status argv + env. T2 caller env preserved, hardening values win. T3 diff/show/log
flags. T3b nested-repository pins/flags on every subcommand. T4 commit keeps hooks enabled, `--quiet`, network blocked unless `repoHooksConfirmed`. T4b the option affects commit only. T5 guard refusal skips spawn.
T6 throwing guard fails closed. T7 passing guard runs the hardened command. T8 every non-commit subcommand disables hooks.
T9 `GIT_ALLOW_PROTOCOL` is empty (caller env cannot re-enable it) and unset only for a hooks-confirmed commit.
T11 literal pathspecs for every non-commit call. T10 `stripTrailingNewline` (used for path-valued git output instead of `trim()`) removes one trailing LF/CRLF only.
