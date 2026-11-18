# Diff Fetcher

Tracked files use `git diff HEAD -- <path>`. If shell output is truncated, the
viewer must not render partial content; it returns a too-large placeholder with
the exact command users can run manually.

The HEAD version for the original pane is read with `git cat-file blob
HEAD:<path>`, not `git show HEAD:<path>`: `show` splits the whole argument at
`..` / `...` first, so a file named `a..b` (next to a path `a` and a branch
`b`) produced a commit log in the original pane. `cat-file` takes a single
object name, in which everything after the colon is the path (real-git
coverage: `repo-safety-real-git` R50–R51).

- T1: tracked diff happy path (HEAD blob via `cat-file blob`).
- T2: truncated tracked diff becomes a too-large result.
