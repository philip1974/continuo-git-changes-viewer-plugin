# Git Viewer Store

The store keeps repo state, file selection, diff cache, loading state, and the
inline banner used for degraded jump-back / large-diff feedback.

- T1: selectFile records the selected path.
- T2: clear resets repo, changes, selection, cache, loading, and banner.
- T3: setBanner/dismissBanner state transition.
- T4: refresh runs the injected loader and replaces repo state.

`statusError` (status could not be read; disables Commit / Amend) is covered
in `status-unavailable`.


The diff cache never outlives the status it was read under:

- T7: a successful refresh drops every cached diff (not only the selected
  one) and loads the selected one again — a staged file that was edited and
  staged again keeps the status `M `, and its cached diff would show the old
  version while a commit takes the new one.
- T8: selecting a row always fetches its diff again.

Overlapping refreshes and diff reads (a manual Refresh, the refresh after a
file operation and the auto-refresh tick can be in flight together): only the
most recently started one lands.

- T9: a slow earlier refresh that succeeds late does not clear the failure a
  later refresh reported (Commit stays disabled).
- T10: the same when the later one throws; and an earlier refresh failing late
  does not put an error over a later success.
- T11: `isLoading` follows the latest refresh.
- T12: a diff read superseded by a newer click on the same row neither
  replaces the newer content nor raises a banner when it fails late.
- T13: a diff read started before a refresh does not land after it.
- T14: asking for a diff that is already being read joins that read.
- T15: `clear()` retires in-flight refreshes and diff reads as well.

The status fingerprint is part of the store. `load` reads it (`status-hash`)
before it reads the list and returns the two together; the store keeps it as
`statusFingerprint`. Every "did the repository change?" question — the
auto-refresh tick, the panel or the window becoming visible again
(`auto-refresh-wiring` T21–T25), the check before a commit — compares the
current fingerprint with this one. Because it was read first, it is never
newer than the list: a change between the two reads leaves an older
fingerprint, which the next comparison reports as a change.

- T16: refresh stores the fingerprint that came with the list (null when the
  load had none); a superseded refresh does not overwrite a newer one;
  `clear()` resets it.
