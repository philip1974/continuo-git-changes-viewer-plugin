# Status Hash

Auto-refresh compares a fingerprint of the repository state before mutating
the viewer store, so unchanged working trees do not trigger refresh side
effects.

The fingerprint is the raw `git status --porcelain=v2 -z` output. v1 only has
the two status letters: staging a second edit of an already staged file
leaves `M  f` unchanged, so the panel kept showing the first staged version
while a commit would take the second. v2 carries the HEAD and index object id
of every entry, so any change of what is staged changes the fingerprint.
Working-tree content is not in it (status does not hash unstaged files into
its output); the shown working-tree diff is checked separately — see
`diff-fetcher` T13 / `auto-refresh-wiring` T19.

- T6: readStatusHash returns raw porcelain v2 stdout through the read-only git wrapper.
- T6b: a non-zero git status result throws.
