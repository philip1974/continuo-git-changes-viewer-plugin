# discard-file-shell

BDD coverage for working-tree-only file discard.

Submodule entries. `git checkout -- <submodule>` exits 0 and does nothing, so
the panel used to report "Discarded sub" while the entry stayed as it was.
`discardFile` first asks the index (`ls-files -s`) whether the path is a
gitlink.

- T12: an index record with mode 160000 → refused with an explanation;
  checkout is not run.
- T13: only the path's own record counts; a probe that fails, times out or is
  cut short does not block the discard.

What sits at the path now. `git checkout -- x` restores the file by first
removing whatever is at `x`. When the file was replaced by a directory (status
` D x`; by a nested repository: ` T x`) that means the whole directory,
including content git does not track — and git does not even list those
untracked files while `x` is still an index entry, so the panel never showed
them. The same happens one level up: with `a/b` tracked and `a` now a file,
`git checkout -- a/b` deletes the file `a`. `discardFile` looks at the path
first (`worktree-entry`) and refuses in those cases; it also refuses when it
cannot look (fail-closed — this is the destructive operation).

- T14: a directory at the path → refused, checkout not run.
- T15: a file or link where a parent folder was → refused, naming the parent.
- T16: no file access / an lstat error other than not-found → refused; a
  missing file, a regular file, a link and a FIFO are checked out as before.
- T17: a submodule entry is still answered as a submodule, before the working
  tree is looked at.

Real git: `repo-safety-real-git` R77–R77b.
