# Commit Hooks Confirmation

Every plugin git call except `commit` runs with `-c core.hooksPath=/dev/null`,
so Stage / Unstage / Discard / refresh never execute repository hooks (index
writers fire `post-index-change`, checkout/restore fire `post-checkout`).
`commit` deliberately keeps running the user's hooks (pre-commit etc.), so
before committing the editor checks whether git would run any:

- `core.hooksPath` set in `local` / `worktree` config → hooks present.
- `core.hooksPath` set only in global / system config → user-owned, no prompt
  (git then ignores `.git/hooks`).
- Otherwise `<git-common-dir>/hooks` (works for linked worktrees / gitdir
  files) is checked with `lstat` (no link following). Only an explicit `ENOENT`
  means none — a raw `code: 'ENOENT'` or the host IPC message whose text starts
  (after the optional `Error invoking remote method '…':` prefix) with
  `ENOENT:`; `ENOENT` appearing only inside a path does not count.
- A directory or symlink is listed; any non-`.sample`, non-directory entry →
  hooks present. A symlinked hooks dir pointing outside the workspace (hostile
  archive: `repo/.git/hooks -> ../../evilhooks`, which git follows) fails the
  host's scope check on `listDir` → unknown, never "missing".
- Any other failure (git error, no `app.fs` / `lstat`, scope error, `EACCES`,
  hooks path is a regular file, listing fails) → unknown, which also prompts
  (fail-closed).

When hooks are present or unknown, clicking Commit / Amend shows an inline
warning naming the hooks and does not commit; "Commit and run hooks" commits,
"Cancel" dismisses. Without hooks, Commit behaves exactly as before. Each
commit attempt re-detects.

H1-H7, H13-H15 detection (mocked shell/fs). H8-H12 CommitEditor prompt
behavior. Real-git coverage lives in `repo-safety-real-git` (R7-R13).
