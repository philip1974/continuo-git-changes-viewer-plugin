# Auto Refresh Wiring

The panel subscribes to dockview visibility events and uses the plugin-owned
timer. It compares raw status output before calling store.refresh.

- T9: visible panels start polling on mount.
- T10: hidden visibility events stop polling.
- T10b: visible visibility events restart polling.
- T11: initial raw hash is read without forcing a refresh.
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
