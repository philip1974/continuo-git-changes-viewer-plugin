# Status Scanner

The file list is built from `git status --porcelain=v1 -z`, then enriched by
numstat binary detection.

- T1: maps modified/added/deleted/untracked records.
- T2: maps rename records with oldPath and path.
- T3: marks binary files by joining numstat data.
- T4: calls git through the read-only exec wrapper.
