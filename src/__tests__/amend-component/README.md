# amend-component

BDD coverage for CommitEditor amend UI.

- T20-T24: separate amend row, disabled state, prefill, clear-on-off, and stale toggle guard.
- T25-T33: labels, submit options, no-op SHA detection, success/failure state, visible warning, fresh-repo re-enable, and retryable read failure.

- T34: a HEAD message containing U+FFFD (its bytes were not valid UTF-8 and
  the commit has no usable `encoding` header) is pre-filled as decoded, with a
  warning that amending saves the message as shown. Amend is not blocked: the
  text is visible and editable.
