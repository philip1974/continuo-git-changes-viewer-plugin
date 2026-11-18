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
entry itself: a submodule entry in the index (` M sub`), or a directory below
which `git add` would add nothing — a nested repository (` T x`; git records
one gitlink entry and does not go into it), an empty directory, or one holding
only ignored files (what gets staged is the deletion of `x`). That question is
put to git: `ls-files -o --exclude-standard -z -- x` lists what `git add` would
pick up, reading directories only. It used to be answered by an lstat of
`x/.git`, but an empty file or folder of that name, or a gitfile pointing
nowhere, is not a repository and git adds everything inside all the same.
`git add -n` was not used: a dry run still runs the clean filter on every file
it would add (measured on git 2.50 / 2.56) and has no `-z`. Untracked rows are not looked at: there the user
clicked that very file or folder. Fail-closed when the path cannot be looked
at.

- T6: plain directory at the path → refused, `git add` not run.
- T7: submodule entry / nested repository → staged as before; entries below
  the path or a failed index query do not count as "the entry itself".
- T9: a `.git` inside the directory proves nothing and is no longer looked at;
  a nested repository in a subdirectory counts as "would add below"; a query
  that fails, times out or is cut short refuses (one record read before the
  cut is enough to refuse); names that merely start with the same letters do
  not count; no records → staged.
- T8: no file access / lstat error → refused; a missing file (a deletion), a
  file under a parent that is no longer a folder, a link and a regular file
  are staged as before; an untracked row triggers no lstat.

Real git: `repo-safety-real-git` R78, R84.

An index entry above the path. While `x` is still a file in the index,
`git add -- x/new` records the removal of `x` along with the new file. Such a
row is listed when the user has `status.showUntrackedFiles=all` (` D x` plus
`?? x/new`), or when the list is out of date. `stageFile` asks the index for
each ancestor (see `unstage-file-shell` T11–T12) and refuses, for untracked
and tracked rows alike.

- T10: ancestor entry → refused, naming it; a folder ancestor does not block;
  an unanswerable query refuses.
- T11: 40 levels deep → at most one git process at a time; more than 64
  ancestors → `PATH_TOO_DEEP_ERROR`, nothing run (see `unstage-file-shell`
  T14–T16).

Real git: `repo-safety-real-git` R87, R88.
