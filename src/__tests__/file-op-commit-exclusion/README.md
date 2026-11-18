# file-op-commit-exclusion

The panel's own index / worktree writes (Stage / Unstage / Discard, file level
and hunk level) and Commit / Amend never overlap.

Why: the commit check (`commit-editor-component` T29–T35) compares what was on
screen at the click with the repository right before `git commit`. It knew
about refreshes and diffs in flight, not about the panel's own writes. Clicking
Stage and then Commit at once let the `git add` land after the fingerprint was
read and before `git commit` read the index: the commit took `f,x` while `x`
was only in the Changes section at the click (reviewer, forced timing; natural
timing 2 of 5 at 0 ms with a 16-level path).

- The store counts writes in flight (`writesInFlight`, +1 at the click, −1 when
  the git command and the refresh after it are done, also on failure /
  rejection) and keeps a write version that only grows (`writeVersion`).
- While a write is in flight, Commit / Amend are disabled with a tooltip. At
  the click the store is checked again (the button may not have re-rendered
  yet). The last check before `git commit` (after every await) aborts and
  refreshes if any write started since the click — also one started while the
  hooks prompt was open.
- While a commit is in flight (`commitInFlight`, set at the click in the same
  synchronous step as the check above), the file-level Stage / Unstage /
  Discard buttons, the hunk buttons and the drawer's confirm button are
  disabled; a click that slips through is refused without running git.
- Commits in flight are counted in the store (`beginCommit()` returns an end
  function that takes back only its own commit, once; `commitInFlight` is
  `commitsInFlight > 0`). The flag is not the CommitEditor's local state: a
  panel closed and opened again while a commit runs gets a new CommitEditor,
  which still sees it — Commit / Amend are disabled ("Committing...") and a
  click that slips through is refused without running git. The click that
  only opens the hooks prompt ends its own mark, never another commit's. The
  open prompt itself does not hold a mark (file writes stay usable; confirming
  after one ran commits nothing — P12).

Specs:

- X1: store counter / version semantics. X1b: commit counter (`beginCommit`).
- X2–X5: CommitEditor (disabled + tooltip, click-time check, check before
  `git commit`, commit-in-flight flag).
- X9–X11: a commit already in flight elsewhere (disabled + "Committing..." +
  tooltip; click-time refusal; the hooks-prompt path ends only its own mark).
- X6–X8: GitViewerPanel (counter spans the git command and the refresh; a
  rejecting write still ends; writes are blocked while a commit runs).
- Real git: `repo-safety-real-git/panel-real-git.spec.tsx` P10–P12, P14–P15.
