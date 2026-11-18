# filelist-row-actions

BDD coverage for FileList row action buttons and accessibility.

- T40: an unmerged row shows a CONFLICT badge (tooltip: why Unstage and
  Discard are missing) in both sections it appears in, has no Unstage /
  Discard button, and its Stage button's tooltip reads "Mark … as resolved
  (git add)"; ordinary rows are unchanged. The tooltip does not say "then
  stage the result": `AA` / `UU` / `AU` / `UA` rows have no Stage button, so
  it points to `git add` in a terminal.
