# amend-component

BDD coverage for CommitEditor amend UI.

- T20-T24: separate amend row, disabled state, prefill, clear-on-off, and stale toggle guard.
- T25-T33: labels, submit options, no-op SHA detection, success/failure state, visible warning, fresh-repo re-enable, and retryable read failure.

- T34: a HEAD message containing U+FFFD (its bytes were not valid UTF-8 and
  the commit has no usable `encoding` header) is pre-filled as decoded, with a
  warning that amending saves the message as shown. Amend is not blocked: the
  text is visible and editable.

Amend rewrites the commit whose message was loaded. A fingerprint that
includes HEAD makes the panel refresh when HEAD moves, but the editor still
holds the message of the old commit: clicking Amend then rewrote the new HEAD
with it (measured: `repo-safety-real-git` P4 fails that way without this
check). Checking Amend now records HEAD's commit id (read before the message)
in the store as `amendHead`; clicking Amend compares it with the current HEAD.
Different, unreadable, or nothing recorded → nothing is amended, Amend is
turned off (the text is kept), the view is refreshed and a warning says why.

- T35: the id is read first and stored with the Amend state; unchecking
  forgets it.
- T36: HEAD is a different commit at click time → no amend, Amend off, text
  kept, one refresh, the warning text.
- T37: fail-closed when HEAD cannot be read or no id was recorded.
- T38: an unreadable HEAD id while checking Amend is handled like an
  unreadable message.
