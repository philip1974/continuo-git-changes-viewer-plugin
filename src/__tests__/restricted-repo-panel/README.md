# Restricted Repository (panel behavior)

When the repository-scope git config contains settings that execute external
programs (see `repo-safety`), the viewer does not run git for that repository.

- B1: a refresh probes the config first; when restricted, `repoRoot` stays null
  (commit / stage / discard / auto-refresh have nothing to act on), no other git
  command runs, and the store carries the restriction message.
- B2: every refresh re-probes; once the user removes the settings, a refresh
  clears the restriction and the viewer works normally again.
- B3: the panel shows the restriction as a persistent alert (no dismiss button).
- B4: `onload` installs the guard on `app.shell`, so any helper that calls
  `gitExec` (auto-refresh status hash, commit editor HEAD reads, write ops) is
  refused on a restricted repository.
