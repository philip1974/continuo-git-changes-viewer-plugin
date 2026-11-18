# Git Exec Wrapper

Every git call goes through `gitExec` (plugin shell SDK). It hardens each
invocation against executable settings in an untrusted repository config:

- Global options: `--no-optional-locks --no-pager -c core.fsmonitor=false
  -c log.showSignature=false -c submodule.recurse=false`, plus
  `-c protocol.allow=never` for every command except `commit` (commit runs the
  user's hooks, which inherit `-c` values and may legitimately fetch), and
  `-c core.hooksPath=/dev/null` for every command except `commit`: index /
  worktree writers (`add`, `apply --cached`, `restore`, `reset`, `checkout`)
  otherwise run `post-index-change` / `post-checkout` hooks planted in an
  untrusted `.git/hooks`. `commit` keeps hooks (see `commit-hooks-confirm`).
- Per subcommand: `diff` → `--no-ext-diff --no-textconv --ignore-submodules=dirty`;
  `show` / `log` → `--no-ext-diff --no-textconv --no-show-signature`;
  `status` → `--ignore-submodules=dirty` (no recursion into nested repos whose
  config is not inspected).
- Env: `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=:`, and
  `GIT_NO_LAZY_FETCH=1` (except `commit`).
- An app shell may carry a guard (see `repo-safety`); a refusal or a guard error
  returns a failed result (exit 128) and git is not spawned (fail-closed).

T1 status argv + env. T2 caller env preserved, hardening values win. T3 diff/show/log
flags. T4 commit keeps hooks working (no network block, no hooksPath override). T5 guard refusal skips spawn.
T6 throwing guard fails closed. T7 passing guard runs the hardened command. T8 every non-commit subcommand disables hooks.
