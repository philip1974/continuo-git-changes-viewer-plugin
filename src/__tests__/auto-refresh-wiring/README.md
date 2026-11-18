# Auto Refresh Wiring

The panel subscribes to dockview visibility events and uses the plugin-owned
timer. It compares raw status output before calling store.refresh.

- T9: visible panels start polling on mount.
- T10: hidden visibility events stop polling.
- T10b: visible visibility events restart polling.
- T11: the first mount does not refresh twice — the mount-time load puts the
  fingerprint in the store, and the comparison made when polling starts finds
  it unchanged.
- T11b: a comparison that arrives while a refresh is in flight does not start
  a second one.
- T12: equal hashes skip refresh.
- T13: changed hashes call refresh.

Status errors recover on their own. When the last refresh did not get a
trustworthy status (`statusError`, see `status-unavailable`), Commit / Amend
are disabled. The tick used to compare status hashes only, so after one
transient failure with an unchanged status nothing refreshed until the user
pressed Refresh. While `statusError` is set, a tick now runs a full
`store.refresh()` instead of the hash comparison — backing off while it keeps
failing (`RetryBackoff`: retries 1, 2, 4, 8 … ticks apart, capped at about a
minute; intervals of a minute or more retry every tick).

- T14: with `statusError` set and an unchanged hash, the tick refreshes (the
  hash is not read); after success the hash comparison is back.
- T15: persistent failure at a 5 s interval → retries on ticks 1, 3, 7, 15,
  27, 39.
- T16: a success resets the back-off (next error retried on the next tick,
  gaps start over).
- T17: a hidden window does not retry; a successful manual Refresh ends the
  retries.
- T18: an error with no repository root known is retried too.
- B1–B3 (`retry-backoff.spec.ts`): the tick arithmetic of `RetryBackoff`.


What the tick compares. The status fingerprint (`status-hash`: porcelain v2,
with HEAD / index object ids) covers everything staged. It does not cover
working-tree content, so the tick also compares the stamp of the selected
Changes / untracked file with the one its shown diff was read under
(`diff-fetcher` T13–T15).

- T19: same fingerprint but the selected Changes file's stamp changed → the
  tick refreshes; unchanged stamp → no refresh.
- T20: with a Staged selection the working tree is not looked at.
- T26: while the diff on screen is an old one being re-read
  (`diffRefreshingKey`, `git-store` T17), its outdated stamp does not trigger
  another refresh — that would cancel the read in flight on every tick.
- T27: the header shows "Refreshing diff…" exactly while the selected row
  shows such an old diff. It sits in the header, not in the diff area: adding
  and removing a line inside the scroll container would make the view jump.

One baseline. Since v0.2.0 the panel kept its own "last fingerprint" and,
every time polling started, overwrote it with the current fingerprint without
comparing. Polling stops while the panel is hidden, so: staged `f` = v1 shown
→ switch to another dock tab → edit `f` and `git add` it in a terminal →
switch back, and the panel kept showing v1 on every later tick while a commit
took v2 (measured with the real panel and real git). The panel no longer has a
baseline of its own. The fingerprint is read by `load` before the list and
kept in the store (`git-store` T16, `status-unavailable` S13); the tick, the
panel becoming visible and the window becoming visible all run the same
comparison of the current fingerprint with the stored one, and the last two
run it at once instead of waiting for a tick. A comparison is skipped while a
refresh is in flight (that refresh brings its own fingerprint) and while
`statusError` is set (the retry path above owns that case).

- T21: hidden → the fingerprint changes → visible again: one refresh, before
  any tick; later ticks see the stored fingerprint and do nothing.
- T22: hidden and visible again with nothing changed: no refresh.
- T23: a tick compares with the stored fingerprint, not with what the previous
  tick read — a change whose refresh did not land is still a change.
- T24: a stored fingerprint of null never compares equal.
- T25: `visibilitychange` to visible compares at once; nothing happens while
  the window or the panel is hidden. (The event is unreliable in Electron on
  macOS; the next tick runs the same comparison.)

Real panel + real git: `repo-safety-real-git` P1.
