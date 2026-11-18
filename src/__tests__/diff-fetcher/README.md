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
- T10: why a failed index read failed. It is reported as `no-staged-blob`
  ("submodule entry or unresolved merge conflict") only when that is the
  case: the status code is an unmerged one (`DD AU UD UA DU AA UU`, no extra
  command), or `git ls-files -s -z -- <path>` (run only after a failed read)
  lists the path as a gitlink (mode 160000) or only at stages 1–3. Anything
  else — guard refusal, killed process, a stage-0 blob that could not be read,
  `ls-files` itself failing / timing out / truncated / not listing the path —
  is `staged-unreadable`; the panel then says the content could not be read
  and that a commit would still include it (`render-limits` L9b). Commit stays
  available either way.

- T11: in changed mode "nothing on the new side" is decided from the
  working-tree column (`Y === 'D'`), so `AD` / `RD` (merged status `A` / `R`)
  read nothing from the working tree.
- T12: a new symbolic link is recognised from the extended diff header (`new
  file mode 120000`, only before the first hunk) and flagged
  `modifiedIsSymlink`; the panel labels it instead of showing the target path
  as content (`diffview-section-views` V4).

Real-git coverage: `repo-safety-real-git` R50–R51c (names, non-blobs,
symbolic links), R57–R58 (large files), R61–R62 (staged content), R64 (read
timeout) and R69 (unreadable staged version).


Working-tree stamp. Editing an unstaged file again leaves its status letters
unchanged, and status output has no id for working-tree content, so the
status fingerprint (`status-hash`) cannot notice it. A Changes / untracked
diff therefore records `worktreeStamp` — kind, size and mtime from
`app.fs.lstat` (the link itself, never its target; nothing is read) — taken
before the file is read. The auto-refresh tick compares it with the file's
current stamp (`auto-refresh-wiring` T19).

- T13: Changes / untracked diffs carry the stamp, taken before `cat`; Staged
  diffs have none; a link is stamped as a link, a missing file as `missing`.
- T14: no stamp when it cannot be taken (no `app.fs`, scope error, unsafe
  path); the diff is still returned and never reported stale.
- T15: `isWorktreeDiffStale` is true only when the diff has a stamp and the
  file now has a different one.
