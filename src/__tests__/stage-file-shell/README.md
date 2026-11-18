# stage-file-shell

BDD coverage for file-level `git add -- <path>` staging.

T5: a row from the Untracked section is added with `untracked: true` — the
`add` keeps the repository's `core.precomposeUnicode` (the name came from git
reading the directory under that setting); tracked rows carry the
`core.precomposeUnicode=false` pin so the argument reaches git unchanged (see
`exec` T13).

A tracked row is not staged as a directory. The Stage button on a ` D x` row
runs `git add -- x`. If a plain directory now sits at `x`, git adds every
untracked file inside it — content that row never showed (and that the list
does not show at all while `x` is still an index entry). `stageFile` looks at
the path first (`worktree-entry`) and refuses, unless the directory is the
entry itself: a submodule entry in the index (` M sub`) or a nested repository
(` T x`, recognised by the `.git` inside; git records one gitlink entry and
does not go into it). Untracked rows are not looked at: there the user
clicked that very file or folder. Fail-closed when the path cannot be looked
at.

- T6: plain directory at the path → refused, `git add` not run.
- T7: submodule entry / nested repository → staged as before; entries below
  the path or a failed index query do not count as "the entry itself".
- T8: no file access / lstat error → refused; a missing file (a deletion), a
  file under a parent that is no longer a folder, a link and a regular file
  are staged as before; an untracked row triggers no lstat.

Real git: `repo-safety-real-git` R78.
