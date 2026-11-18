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
  The message says the state of the repository could not be confirmed (with
  the reason), not that it changed; the view is refreshed once.
- T32: Amend goes through the same check.
- T33: with repository hooks the check runs after the user confirmed them —
  last thing before `git commit`.
- T34: without host notifications the warning is the dismissable banner.
- T35: while the Staged diff on screen is an old one whose replacement is
  still being read (`git-store` T17), nothing is committed and a warning asks
  to wait — an equal fingerprint says the list is current, not that this
  content is. A Changes diff being refreshed does not hold a commit back.

The baseline is what was on screen at the click. It used to be read from the
store *after* the current fingerprint had been read: a refresh in flight could
land during that await, store and repository then agreed on the new state and
the comparison passed — the click saw v1 and v2 was committed. Now a snapshot
(fingerprint, the store's `refreshVersion`, the selected Staged diff object) is
taken synchronously on entry, before any await; with repository hooks it is the
snapshot of the click that opened the confirmation.

- T36: a refresh lands while the fingerprint is being read (store and
  repository both new) → no commit, "the view was refreshed after you clicked".
- T37: the same when the refresh brought an identical fingerprint — any landing
  counts; no extra refresh is made.
- T38: a refresh is in flight at the click → no read, no commit, "still being
  refreshed".
- T39: Amend goes through the same comparison.
- T40: a refresh landing while the hooks confirmation is open stops the commit
  after the user confirms.
- T41: the selected Staged diff was replaced between click and comparison → no
  commit.
- T42: nothing landed, same fingerprint → the commit goes through.

Residual (human timing, not handled): a refresh that landed just before the
click — the new list is in the store, possibly not yet painted or read.

Real panel + real git: `repo-safety-real-git` P2–P3, P5–P6.

