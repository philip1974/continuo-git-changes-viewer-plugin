# host-exec-rejection

Continuo can refuse to run a command for the plugin (`app.shell.exec`
rejects): too many processes running in the window at once (32), the plugin's
permission revoked, … The rejection reaches whatever awaited the git call. Every
user-initiated entry point catches it, tells the user why, leaves no unhandled
rejection, and returns to a state where the action can be retried. Stage /
Unstage / Discard (file and hunk drawers) already did; the commit editor did
not (reviewer, measured: a refused `git commit` showed nothing and left an
unhandled rejection; a refused `rev-parse HEAD` while checking Amend left Amend
checked with an empty editor and the draft only in the store).

Commit / Amend (`commit-editor-rejection.spec.tsx`):

- H1: `git commit` refused → "Commit failed: <reason>", message kept, the
  commit count back to 0, button usable again.
- H2: reading HEAD right before amending refused → nothing amended, "Amend
  failed: <reason>", Amend and the text kept.
- H3: the amend went through but reading HEAD afterwards is refused → reported
  as amended (only the "HEAD unchanged" check is skipped), not as a failure.

Checking Amend:

- H4 / H5: reading HEAD's id or message refused → Amend off, the draft back,
  "Failed to read HEAD commit message: <reason>".
- H6: a refusal arriving after Amend was unchecked (or checked again) changes
  nothing and reports nothing.

Checking whether there is a last commit (on mount):

- H7: refused → HEAD state unknown (`null`): the checkbox stays disabled and
  its tooltip gives the reason. `null` opens nothing: checking Amend and the
  Amend button both require a known HEAD commit.
- H8: Amend already on when the check is refused → the Amend button is
  disabled; the checkbox can still be unchecked (draft back), and cannot be
  checked again.

Other entry points checked for the same gap: Stage / Unstage
(`GitViewerPanel` `runFileAction`), the file and hunk drawers
(`handleDrawerConfirm` in `GitViewerPanel` and `DiffView`), jump-back
(`openFile` has its own catch) and the settings tab already catch. Refresh
(button, command, mount, auto-refresh) goes through `git-store` `refresh` /
`loadDiff`, which never reject (failures become `statusError` / a banner);
the auto-refresh's own fingerprint and worktree-stamp reads are caught and
logged, and retried on the next tick. The "Diff too large" Copy button did not
catch a refused clipboard write — see `copy-command` Q12 / Q13.
