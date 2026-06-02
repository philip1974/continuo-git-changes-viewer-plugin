# can-amend

BDD coverage for amend eligibility.

- T14: no HEAD disables amend.
- T15-T16: empty/whitespace message disables amend even with staged files.
- T17-T18: non-empty message enables amend with or without staged files.
- T19: helper stays pure and does not import store state.

