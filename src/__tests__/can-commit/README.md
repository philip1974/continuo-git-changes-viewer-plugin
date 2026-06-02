# can-commit

BDD coverage for commit eligibility.

- T11: empty message disables commit.
- T12: whitespace-only message disables commit.
- T13: zero staged files disables commit.
- T14: non-empty message plus staged files enables commit.
- T15: helper remains pure and does not import store selectors.

