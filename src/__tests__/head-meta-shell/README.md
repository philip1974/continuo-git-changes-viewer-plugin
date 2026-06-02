# head-meta-shell

BDD coverage for HEAD metadata helpers used by amend.

- T1-T2: `hasHeadCommit` maps `rev-parse --verify HEAD` success/failure.
- T3-T5: `readHeadMessage` preserves full message content and trims only trailing newlines.
- T6-T7: `readHeadSha` reads or returns null.
- T8: `readHeadMessage` uses the no-lock git wrapper.

