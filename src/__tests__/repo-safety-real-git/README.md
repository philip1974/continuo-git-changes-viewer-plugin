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
