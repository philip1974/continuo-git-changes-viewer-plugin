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
