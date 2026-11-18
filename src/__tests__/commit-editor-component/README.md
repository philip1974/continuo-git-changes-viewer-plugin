# commit-editor-component

BDD coverage for the CommitEditor UI.

- T16-T17: textarea is bound to `store.commitMessage`.
- T18-T22: disabled gates prevent commit shell calls.
- T23-T28: valid commit, success, failure, in-flight state, and ASCII truncation.

The index is confirmed right before the commit. The panel shows what the last
refresh read; `git commit` takes the index as it is at that moment. With
auto-refresh off, or between two ticks, a `git add` in a terminal used to be
committed without ever having been shown. Before running `git commit` (and
`git commit --amend`) the editor reads the current status fingerprint and
compares it with the one stored with the list (`git-store` T16). Different,
unreadable, or no stored fingerprint → no commit; the store is refreshed and a
warning says so. The message draft, the Amend state and the hooks decision are
not carried over silently: the hooks prompt closes and the user clicks again.
Residual: the window between reading the fingerprint and git reading the index
(two process starts).

- T29: changed fingerprint → no commit, one refresh, the warning text, message
  kept.
- T30: the next click (fingerprint now equal) commits; the fingerprint is read
  on every attempt.
- T31: fail-closed when the fingerprint cannot be read, or the store has none.
- T32: Amend goes through the same check.
- T33: with repository hooks the check runs after the user confirmed them —
  last thing before `git commit`.
- T34: without host notifications the warning is the dismissable banner.
- T35: while the Staged diff on screen is an old one whose replacement is
  still being read (`git-store` T17), nothing is committed and a warning asks
  to wait — an equal fingerprint says the list is current, not that this
  content is. A Changes diff being refreshed does not hold a commit back.

Real panel + real git: `repo-safety-real-git` P2–P3.

