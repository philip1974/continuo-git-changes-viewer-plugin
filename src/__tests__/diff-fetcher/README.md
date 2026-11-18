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

Size limits. The host's `shell.exec` caps stdout at 10 MiB by default (the
rest is dropped and `truncated` is set). The unified diff relies on that
default (T2). The two whole-file reads — `cat-file blob HEAD:<path>` and `cat
-- <path>` — pass an explicit `maxOutputBytes` of `MAX_FILE_BYTES` (1 MiB): a
new / untracked file is rendered as one block of text, and 10 MiB of it with
no hint that it was cut is neither usable nor honest.

- T3: both whole-file reads carry the 1 MiB limit; the diff call does not.
- T4: a working-tree file over the limit → the part that was read, flagged
  `modifiedTruncated` (the panel adds a "File too large" notice,
  `render-limits` L7); within the limit → no flag.
- T5: a HEAD blob over the limit does not fail the diff; `original` is just
  the part that was read (it is only used to tell "no HEAD version" apart).

Real-git coverage: `repo-safety-real-git` R50–R51c (names, non-blobs,
symbolic links) and R57–R58 (large files).
