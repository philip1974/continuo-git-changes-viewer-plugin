# Commit Hooks Confirmation

Every plugin git call except `commit` runs with `-c core.hooksPath=/dev/null`,
so Stage / Unstage / Discard / refresh never execute repository hooks (index
writers fire `post-index-change`, checkout/restore fire `post-checkout`).
`commit` deliberately keeps running the user's hooks (pre-commit etc.), so
before committing the editor checks whether git would run any:

- `core.hooksPath` set in `local` / `worktree` config → hooks present.
- `core.hooksPath` set only in global / system config → user-owned, no prompt
  (git then ignores `.git/hooks`).
- Otherwise any non-`.sample`, non-directory entry in `<git-common-dir>/hooks`
  (works for linked worktrees / gitdir files) → hooks present; a missing hooks
  directory means none.
- Any failure (git error, no `app.fs`, unreadable directory) → unknown, which
  also prompts (fail-closed).

When hooks are present or unknown, clicking Commit / Amend shows an inline
warning naming the hooks and does not commit; "Commit and run hooks" commits,
"Cancel" dismisses. Without hooks, Commit behaves exactly as before. Each
commit attempt re-detects.

H1-H7 detection (mocked shell/fs). H8-H12 CommitEditor prompt behavior.
Real-git coverage lives in `repo-safety-real-git` (R7-R11).
