# can-file-ops

BDD coverage for file-level write-op eligibility.

T30: a type change (`T`) has the file-level actions of a modification — Stage
and Discard in Changes (`T` in the working-tree column), Unstage in Staged
(`T` in the index column).

Unmerged paths (status `DD AU UD UA DU AA UU`). The X of `AA` / `AU` / `DD` /
`DU` is `A` or `D`, so those rows used to get an Unstage button; `git restore
--staged` exits 0 on `AA` / `AU` and drops the conflict stages — `AA` became
` M`, `AU` became clean — while the toast only said "Unstaged". `UD` / `DD`
got a Discard button whose `git checkout --` can only fail on an unmerged
path. Neither is offered for an unmerged path any more; the row carries a
CONFLICT badge saying so (`filelist-row-actions` T40). Stage is unchanged
(offered for `UD` / `DD` only — nothing was opened up); what it does there is
`git add`, i.e. mark the conflict resolved, and the toast and button tooltip
say that (`file-level-integration` T40).

- T31: no Unstage and no Discard for any unmerged code in any section;
  ordinary combinations (`AM`, `AD`, `MD` …) are unaffected.
- T32: Stage on unmerged codes is exactly as before: `DD` and `UD` only.
- T33: an intent-to-add entry (` A`) has no file-level action.

Real git: `repo-safety-real-git` R82–R83.
