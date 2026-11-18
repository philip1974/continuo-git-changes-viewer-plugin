# Path Utils

Pure helpers for translating git repo-relative paths into absolute Continuo
editor paths.


Paths come from `git status`, i.e. from the (possibly hostile) repository's
index. A forged index can list `../outside.txt`, absolute paths or
`.git/hooks/pre-commit`; git reports them without validation and
`git checkout -- .git/hooks/x` even writes into the git directory. The plugin
therefore only accepts canonical repo-relative paths:

- T1–T4 `joinRepoPath` returns `null` (never an outside path) for anything
  else.
- T5–T6 `isSafeRepoRelativePath`: not empty, not absolute (POSIX, UNC, drive
  letter), no empty / `.` / `..` segment (one trailing `/` is allowed for
  untracked directories), and no segment that resolves to `.git` on HFS+ /
  NTFS (case, ignorable code points, trailing dots and spaces, `git~1`,
  alternate data streams). Glob characters are fine — paths are passed to git
  literally.

The same predicate gates the status parser (entries are dropped), `fetchDiff`,
stage / unstage / discard file, and the hunk-action predicates.

- T8–T9 `isForgedIndexPath`: the subset git itself never writes into an index
  (POSIX-absolute, an empty / `.` / `..` segment, a `.git` segment). Such an
  entry means the index was forged; the status scan then refuses the whole
  repository (see `status-scanner` T7). Names that are only unsafe on Windows
  (`c:notes.txt`, `..\x`) are legitimate file names elsewhere: still dropped,
  but they do not condemn the repository.
