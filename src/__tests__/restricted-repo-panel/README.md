# Restricted Repository (panel behavior)

When the repository could make git run external programs or reach outside the
workspace (see `repo-safety`: executable or redirecting config keys, a working
tree that is not the workspace root, a git directory outside the workspace,
symbolic links inside the git directory), the viewer does not run git for it.

- B1: a refresh probes the config first; when restricted, `repoRoot` stays null
  (commit / stage / discard / auto-refresh have nothing to act on), no other git
  command runs, and the store carries the restriction message.
- B2: every refresh re-probes; once the user removes the settings, a refresh
  clears the restriction and the viewer works normally again.
- B3: the panel shows the restriction as a persistent alert (no dismiss button).
- B4: `onload` installs the guard on `app.shell`, so any helper that calls
  `gitExec` (auto-refresh status hash, commit editor HEAD reads, write ops) is
  refused on a restricted repository.
- B5: the same holds for the redirection cases — `core.worktree` in local
  config, git resolving the working tree elsewhere, a git directory outside
  the workspace, a symbolic link inside the git directory; the alert names the
  reason.
- B6: a refresh waits for the fs scope request to settle before probing,
  because the symlink check needs file access (without it the repository would
  be reported as restricted).
