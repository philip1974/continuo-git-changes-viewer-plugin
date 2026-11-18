# Stage hunk eligibility

BDD coverage for the centralized rules that decide whether a hunk may show a
Stage button.

T13: the unstaged modification of a staged new file (`AM`) is eligible — the
Changes section shows it as an index → working-tree diff
(`diffview-section-views`); `AD`, `AA` and `RM` are not.

T20: a type change (`T` on the working-tree side — file ↔ symbolic link ↔
submodule) is never eligible: git writes it as a deletion plus an addition.

T21: independent of the status code, a diff that `isHunkPatchableDiff`
(`hunk-patch-builder` T5) rejects is not eligible; chmod + edit and a
retargeted symbolic link remain eligible.

T22: a diff whose text contains U+FFFD (bytes that were not valid UTF-8 when
the host decoded git's output) is not eligible — the patch would write the
replacement character back (`hunk-patch-builder` T8).
