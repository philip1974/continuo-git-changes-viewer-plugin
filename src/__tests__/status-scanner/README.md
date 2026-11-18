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
- T6: entries whose path or rename source is one git never records (see
  `path-utils`: absolute, `..`, inside a `.git` directory — a forged index can
  contain them) are dropped by the parser.
- T7: if any dropped path is one git itself never records (`isForgedIndexPath`:
  absolute, `..`, inside `.git`), the index was forged. Hiding the entry is not
  enough — a staged one would still be written into the tree by `commit` — so
  `scanStatus` rejects with `UnsafeIndexError` and the plugin puts the
  repository into the restricted state (`restricted-repo-panel` B7).
- T8: names git itself records but the plugin will not pass to git
  (`isSafeRepoRelativePath` fails, `isForgedIndexPath` does not: `c:notes.txt`,
  `..\x`, `.git\config`, `\x`, `a:b`) are **kept** as rows marked
  `inoperable`, in whatever state they are. They used to be dropped silently;
  a staged one was then invisible in the panel and still written by `commit`.
- T9: a rename / copy with such a name on either side is one inoperable row;
  forged paths are still dropped by the parser and still fail the scan, even
  next to inoperable ones.

What an inoperable row means in the panel: `inoperable-entries`.
