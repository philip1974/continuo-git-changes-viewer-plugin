# Diff Fetcher

Tracked files use `git diff HEAD -- <path>`. If shell output is truncated, the
viewer must not render partial content; it returns a too-large placeholder with
the exact command users can run manually.

- T1: tracked diff happy path.
- T2: truncated tracked diff becomes a too-large result.
