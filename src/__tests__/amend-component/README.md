# amend-component

BDD coverage for CommitEditor amend UI.

- T20-T24: separate amend row, disabled state, prefill, clear-on-off, and stale toggle guard.
- T25-T33: labels, submit options, no-op SHA detection, success/failure state, visible warning, fresh-repo re-enable, and retryable read failure.

- T34: a HEAD message containing U+FFFD (its bytes were not valid UTF-8 and
  the commit has no usable `encoding` header) is pre-filled as decoded, with a
  warning that amending saves the message as shown. Checking Amend is not
  blocked: the text is visible and editable.
- T39: clicking Amend while that pre-filled message is still unedited amends
  nothing (it would replace the original bytes with `EF BF BD`, measured in
  `repo-safety-real-git` P9): Amend stays on, the text is kept and a warning
  says to edit the message first or amend in a terminal. The pre-filled text
  is kept in the store as `amendMessage`.
- T40: an edited message (even with some U+FFFD left) amends as before, so
  does an unedited message without U+FFFD; unchecking Amend forgets
  `amendMessage`.

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

Typing while the HEAD message is still being read (two git processes) used to
be overwritten when the pre-fill arrived (after e6adc86 the wait is visible).
Now text typed after checking Amend is kept; the loaded message is still
recorded as `amendMessage` (so the U+FFFD rule treats the typed text as
edited), and the U+FFFD warning about the pre-filled text is not shown.

- T41: typed during the wait → kept, `amendMessage` recorded, Amend commits the
  typed text, no U+FFFD warning.
- T42: nothing typed during the wait (a draft typed before checking Amend does
  not count) → pre-filled as before.

Checking Amend replaces the editor's text with HEAD's message. Unchecking used
to clear the editor, so a draft written before checking Amend was lost. The
draft is now kept aside in the store (`amendDraft`) when Amend is checked and
put back when the user unchecks Amend — also when the HEAD message cannot be
read and Amend goes back off. Text edited in Amend mode is not kept on
unchecking (it started as HEAD's message, not as the draft). Other ways Amend
turns off (a successful amend, HEAD changed at the click) forget the draft.

- T43: checked → draft kept in the store; unchecked → draft back.
- T44: edited in Amend mode, then unchecked → the draft, not the edit.
- T45: HEAD message unreadable → Amend off, draft back.
- T46: successful amend → editor empty, draft forgotten.
- T24 (changed): checking and at once unchecking now leaves the draft
  (`'draft'`) instead of an empty editor; the late HEAD message still does not
  overwrite it.
