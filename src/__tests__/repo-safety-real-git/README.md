# Repo Safety — real git integration

Builds throwaway repositories with a real `git` binary whose config points each
executable setting at a script that drops a marker file, then drives the
plugin's git helpers.

- R1: fixture sanity — plain `git status` does run the hostile clean filter.
- R2: hostile filter/textconv/diff.external/gpg+showSignature/fsmonitor → the
  repo is restricted; status/diff/show/log/add/commit through the plugin leave
  no marker.
- R3: an executable setting pulled in through `include.path` is detected.
- R4: without the guard, the hardened argv alone neutralizes textconv,
  diff.external, signature verification and fsmonitor while diffs stay correct.
- R5: a nested repository with its own hostile filter is not recursed into.
- R6: an ordinary repository keeps working (status, diff, stage, commit) and the
  user's own pre-commit hook still runs.
- R7: fixture sanity — with the `core.hooksPath` override stripped, planted
  `.git/hooks` fire on stage / unstage (restore and reset) / stage-hunk /
  unstage-hunk (`post-index-change`) and discard-file (`post-checkout`).
- R8: same planted hooks, config trusted: every plugin write op and refresh
  runs no hook.
- R9: `detectRepoHooks` — samples only or no hooks dir → none, planted hooks →
  present; a confirmed commit still runs pre-commit / post-commit.
- R10: local `core.hooksPath` → present; a linked worktree sees the main
  repository's hooks via `--git-common-dir`.
- R11: `core.hooksPath` from global config only → none.
- R12: `.git/hooks` symlinked to a sibling `evilhooks/` outside the workspace,
  with a host-like scoped fs (realpath before scope check, IPC errors carry only
  the message) → unknown; with a scope covering the target → present; git
  really follows the link and runs its pre-commit.
- R13: host-like scoped fs: samples only / missing hooks dir → none.
