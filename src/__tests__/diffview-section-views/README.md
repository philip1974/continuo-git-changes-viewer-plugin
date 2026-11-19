# Which view a row gets, per section

A file can appear in two sections at once (`AM`, `AD`, `MM`). The view is
chosen from the side of the status that the section shows, not from the merged
status:

- **Staged** (`mode: 'staged'`): index side `A` → whole-file view of the index
  version (`git cat-file blob :0:<path>`); anything else → `git diff --cached`.
- **Changes** (`mode: 'changed'`): only untracked files (`??`) get the
  whole-file view (working-tree file). Everything else — including the `M` of
  `AM` and the `D` of `AD` — gets `git diff -- <path>`, i.e. the index →
  working-tree increment, with hunk actions where the rules allow them.

Before, both sections used the merged status `A`: `AM` in Changes showed the
whole working-tree file (no increment, no hunk actions), and `AD` in Changes
showed "(empty file)" for what is a working-tree deletion.

A staged new **symbolic link** (index mode 120000, taken from the `new file
mode 120000` header of `git diff --cached`; `modifiedIsSymlink`) is labelled
"Symbolic link → <target>" instead of showing the stored target path as if it
were the file's content.

Hunk actions on `AM` in Changes: Stage (`apply --cached`) and Discard
(`apply --reverse`) are offered like for `MM` — the patch is the same kind of
index → working-tree hunk (`can-stage-hunk` T13, `can-discard-hunk` T8).

- V1: `AM` in Changes → increment + Stage / Discard hunk buttons.
- V2: `AM` in Staged → whole staged file, no hunk buttons.
- V3: `AD` in Changes → deletion diff, never "(empty file)"; Staged → whole
  staged file.
- V4: staged new symbolic link → "Symbolic link → <target>" note, no content
  block; an ordinary new file has no such note.
- V5: untracked → whole-file view; withheld staged version → notice.
- V6: `MM` (both sections), intent-to-add ` A`, `M `, and `UA` in Staged
  (merged status `A`, index side not an addition) → unified diff.

Real-git coverage: `repo-safety-real-git` R70.

- V4b: a staged symbolic link whose target was only partly read (size limit or
  timeout) carries the same kind of "only part is shown" notice as a file.
