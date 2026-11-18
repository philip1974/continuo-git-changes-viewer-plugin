

What the tick compares. The status fingerprint (`status-hash`: porcelain v2,
with HEAD / index object ids) covers everything staged. It does not cover
working-tree content, so the tick also compares the stamp of the selected
Changes / untracked file with the one its shown diff was read under
(`diff-fetcher` T13–T15).

- T19: same fingerprint but the selected Changes file's stamp changed → the
  tick refreshes; unchanged stamp → no refresh.
- T20: with a Staged selection the working tree is not looked at.
