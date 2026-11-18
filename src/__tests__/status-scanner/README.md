# Status Scanner

The file list is built from `git status --porcelain=v1 -z`, then enriched by
numstat binary detection.

- T1: maps modified/added/deleted/untracked records.
- T2: maps rename records with oldPath and path.
- T3: marks binary files by joining numstat data.
- T4: calls git through the read-only exec wrapper.
- T5: copy records (`C`, only with `status.renames=copies`; the plugin pins
  `status.renames=true`) consume their original path like renames do and show
  as added files — the original path never becomes an entry of its own.
- T6: entries whose path or rename source is not a canonical repo-relative
  path (see `path-utils`: absolute, `..`, inside a `.git` directory — a forged
  index can contain them) are dropped.
