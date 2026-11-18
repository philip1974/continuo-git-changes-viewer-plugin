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

Time limit. Past the output limit the host only discards the extra output: it
does not close the pipe or stop the process, which runs to completion — or to
the host's default timeout of 30 s. The three whole-file reads therefore also
pass `timeoutMs: FILE_READ_TIMEOUT_MS` (5 s). A read that times out is handled
like an oversized one: what was read is used and flagged.

- T8: HEAD blob, index blob and working-tree `cat` carry the 5 s timeout; the
  unified diff does not.
- T9: a timed-out read of the new side → the part that was read, flagged
  `modifiedTruncated` and `modifiedTimedOut` (the panel says "Reading this
  file took too long", `render-limits` L10); a timed-out HEAD read does not
  fail the diff.

Which version the new side is. In the Changes section (`changed` mode)
`modified` is the working-tree file. In the Staged section (`staged` mode) it
is the version in the index — what a commit would record — read with `git
cat-file blob :0:<path>`. (Before, staged mode read the working tree too: after
`git add n.txt` and a further edit the Staged section showed the edited text
while the commit contained the staged one, and after deleting the file it
showed "(empty file)".) The stage number is explicit because git reads
`:0:x` as "stage 0 of `x`", so a file named `0:x` needs `:0:0:x`.

- T6: staged mode runs `cat-file blob :0:<path>` with the 1 MiB limit and no
  `cat`; changed mode runs `cat` and no index read.
- T7: staged deletion → nothing read; `MD` → index version in staged mode,
  nothing in changed mode; no stage-0 blob (gitlink, unresolved conflict) →
  `withheld: 'no-staged-blob'` (the panel shows a notice, `render-limits` L9).

Real-git coverage: `repo-safety-real-git` R50–R51c (names, non-blobs,
symbolic links), R57–R58 (large files), R61–R62 (staged content) and R64 (read
timeout).
