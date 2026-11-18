# worktree-entry

`probeWorktreeEntry(app, repoRoot, path)` tells what sits at a repository path
in the working tree right now, using `app.fs.lstat` only (links are not
followed, nothing is read).

Why it exists. File-level actions hand a path to git, and git treats a path as
a prefix. A status row (` D x`, ` T x`) does not say what is on disk at `x`
now. When a directory sits there, `git checkout -- x` deletes the directory
with everything in it and `git add -- x` adds every untracked file inside
(`discard-file-shell` T14–T16, `stage-file-shell` T6–T8,
`repo-safety-real-git` R77–R78). Callers treat `unknown` as fail-closed.

- W1: the type of the path itself — file, symlink, directory, other, missing.
- W2: the walk goes down from the repository root and stops at the first
  parent that is not a directory (`parent-not-directory` with that parent's
  path); a missing parent means missing.
- W3: `unknown` when there is no file access, when `lstat` fails with anything
  but not-found, or when the path is not a canonical repository path.
- W4: a not-found error that lost its code over IPC still means missing.
