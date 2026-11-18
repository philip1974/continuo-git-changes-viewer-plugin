# Status Hash

Auto-refresh compares a fingerprint of the repository state before mutating
the viewer store, so unchanged working trees do not trigger refresh side
effects.

The fingerprint is the raw `git status --porcelain=v2 --branch
--no-ahead-behind -z` output. v1 only has
the two status letters: staging a second edit of an already staged file
leaves `M  f` unchanged, so the panel kept showing the first staged version
while a commit would take the second. v2 carries the HEAD and index object id
of every entry, so any change of what is staged changes the fingerprint.
Working-tree content is not in it (status does not hash unstaged files into
its output); the shown working-tree diff is checked separately — see
`diff-fetcher` T13 / `auto-refresh-wiring` T19.

- T6: readStatusHash returns raw porcelain v2 stdout through the read-only git wrapper.
- T6b: a non-zero git status result throws.
- T6c: the command asks for the branch header and skips the ahead / behind
  count; the output is returned untouched, header records included.

HEAD is part of the fingerprint. An entry line only carries the id of the blob
in HEAD, so a new HEAD commit with the same tree left the output unchanged:
with `A  f` staged, `git commit --amend --only -m …` in a terminal (or any
tool moving HEAD) went unnoticed — no refresh, and the check before a commit
(`commit-editor-component` T29–T34) could not see that HEAD was no longer the
commit the user had looked at. `--branch` adds `# branch.oid` / `# branch.head`
(`repo-safety-real-git` R80). `--no-ahead-behind` keeps git from counting the
distance to the upstream on every tick; the panel does not show it. The output
is compared as an opaque string and never parsed; the list comes from a
separate v1 command (`status-scanner`).

Residual — an unstaged submodule pointer that moves again. For a submodule
entry status prints the commit ids recorded in HEAD and in the index plus the
`S<c><m><u>` flags, never the submodule's own current HEAD. With ` M sub`
shown, another commit inside the submodule leaves the output byte-identical
(measured, git 2.50.1 / 2.56.1); no status option prints it (it would take an
extra `git diff` per tick), and the directory's mtime does not change either,
so the working-tree stamp does not notice. Only the `Subproject commit …`
line of that Changes row can be stale, until the row is clicked or Refresh is
pressed. What a commit takes is not affected: a staged pointer lives in the
index, and any change of it changes the fingerprint (`repo-safety-real-git`
R81).
