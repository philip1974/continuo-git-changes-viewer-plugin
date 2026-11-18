# Git store mode selection

BDD coverage for structured selection and mode-keyed diff cache entries.

A row is identified by (path, section), not by path. After `git rm --cached
f`, `git status` lists the path twice: `D  f` (Staged) and `?? f` (Untracked,
mode `changed`). Selection and the diff cache were already keyed by (path,
mode); what was path-only was the lookup of the status record (`selectFile`,
`loadDiff`, selection reconciliation on refresh, and the panel's "selected
change"), which always returned the first record. Clicking the untracked row
fetched the staged deletion's diff ("no textual diff") and a refresh moved the
selection to the Staged row. `findChange(changes, path, mode)` now returns the
record listed in that section.

- T20: `(f, changed)` loads the untracked record, `(f, staged)` the staged
  deletion; cache entries are independent; a section without that path loads
  nothing; record order does not matter.
- T21: a refresh keeps either row selected.
- T22: when the selected row disappears and the path's other record remains,
  selection moves to it.
- T23: inoperable records stay unselectable in either section.
- P1 (`duplicate-path-panel.spec.tsx`): in the panel, the Untracked row shows
  the working-tree file, the Staged row the deletion diff, across switches and
  a refresh; every diff request carries the section's own record.

Real-git coverage: `repo-safety-real-git` R71.

