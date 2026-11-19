# Inoperable entries (names the plugin will not hand to git)

`isSafeRepoRelativePath` rejects more than forged paths: it also rejects names
that are perfectly legal on POSIX and that git records normally, because they
would mean something else on Windows — a drive-letter form (`c:notes.txt`,
`a:b`), a backslash that hides `..` or `.git` (`..\x`, `.git\config`), a
leading backslash. These are not evidence of a forged index (that is
`isForgedIndexPath`, which fails the whole scan), so the scan used to drop
them silently.

Dropping hid a real hazard: such an entry may already be **staged**. The panel
did not show it, yet `git commit -F -` commits everything in the index — the
user committed files the panel never listed.

Now the status scan keeps them as rows marked `inoperable` (`status-scanner`
T8–T9), and the panel shows them read-only:

- I1: no file-level action (stage / unstage / discard) and no hunk action is
  offered for an inoperable entry in any section.
- I2: selection skips them — the first selectable entry is the first ordinary
  one; with only inoperable entries nothing is selected.
- I3: the store never requests their diff (auto-selection on refresh,
  `selectFile`, `loadDiff`).
- I4: asked directly, `fetchDiff` still refuses without starting a process.
- I5: a staged inoperable entry appears in **Staged**, is counted, and carries
  the note "Unsupported file name — cannot be viewed or changed here, but it
  is staged and a commit will include it. Use git in a terminal."
- I6: in Changed / Untracked the note is "Unsupported file name — cannot be
  viewed or changed here. Use git in a terminal."; an entry present in both
  Staged and Changed gets the matching note in each.
- I7: the row is not a control — no row button, no action buttons, clicking
  selects nothing; ordinary rows beside it are unaffected.
- I8: the path is rendered as text only (markup / bidi control characters in
  the name create no elements).
- I9: with only inoperable entries staged, the rows are visible, the staged
  count includes them and Commit is enabled (the user can see what will be
  committed); no `git` argument contains any of those paths at any point, and
  nothing but `git` is started (no `cat`, no `lstat` of those paths).
- I10: beside ordinary files, the ordinary one is auto-selected; clicking an
  inoperable row changes nothing.
- I11: two names that are different bytes but decode to the same text
  (`caf\xE9.txt` and `caf\xE8.txt` both become `caf�.txt`) are two rows
  in every section, with no duplicate React key (the row index is part of the
  key of an inoperable row only; ordinary rows keep a stable key).
- I12: the two kinds of rows have separate key spaces (`<section>:ro:<index>`
  and `<section>:ok:<XY>:<path>`). Before, an inoperable row's key was its path
  plus `#<index>` and an ordinary row's was its path: `x\..` (inoperable) and
  `x\..#0` (ordinary) shared a key and a refresh left a ghost row in Staged.

Real-git coverage: `repo-safety-real-git` R60 (the rows shown as staged are
exactly the paths in the resulting commit).

Why not disable Commit instead: the user would be blocked from committing in
the panel with no way to fix it there, whereas showing the row tells them
exactly what the commit contains and leaves the decision with them.
