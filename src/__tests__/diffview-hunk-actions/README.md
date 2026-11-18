# diffview-hunk-actions

BDD coverage for Stage, Unstage, and Discard hunk action rendering.

- T19–T22: which hunk buttons each section shows.
- T23: a diff containing U+FFFD (bytes that were not valid UTF-8) shows no
  hunk button in Changes or Staged and a note explaining why and pointing at
  the file-level actions (`hunk-patch-builder` T8); an ordinary diff shows no
  note.
