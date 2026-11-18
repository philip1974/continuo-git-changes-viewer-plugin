# Diff Symlink Guard

The diff view reads the working-tree copy of a file to show new / untracked
files in full. That read must never follow a symbolic link: in an untrusted
folder a tracked or untracked path (or one of its parent directories) can be a
link to a file outside the workspace (`notes.txt -> ~/.ssh/id_rsa`), and git
itself only ever shows the link target path, never the linked file.

Before reading, the path and every parent directory below the repo root are
checked with `app.fs.lstat` (which does not follow links). The content is
withheld — and the panel shows a short notice instead — when any of them is a
symbolic link, or when the check itself cannot be completed (no file access,
scope error, any failure other than an explicit ENOENT). The git unified diff
(which shows the link target as text) is still displayed for tracked files.

- T1: tracked file replaced by a link to an outside file — outside content is not returned; git's diff (link target) still is.
- T2: untracked link to an outside file — content withheld.
- T3: parent directory is a link to an outside directory — content withheld.
- T4: regular tracked / untracked / nested files are read as before.
- T5: host scope error on lstat (message-only IPC error) — content withheld, `cat` is never run.
- T6: file access unavailable (`app.fs` missing) — content withheld.
- T7: explicit ENOENT from lstat is not a link — falls through to the normal (empty) read.
- T8: paths that escape the repo root (`..` segment / absolute) or point into a
  `.git` directory are never read: `fetchDiff` fails without spawning anything
  (see `path-utils`).
- T9: the panel shows a notice instead of file content when content was withheld.
