# can-discard-hunk

BDD coverage for Changed-section discard hunk eligibility.

T8: `AM` in the Changes section is eligible (same index → working-tree hunk
as `MM`; see `diffview-section-views`); `RM` / `CM` stay disabled.

T20: a type change (`T` on the working-tree side — file ↔ symbolic link ↔
submodule) is never eligible: git writes it as a deletion plus an addition.

T21: independent of the status code, a diff that `isHunkPatchableDiff`
(`hunk-patch-builder` T5) rejects is not eligible; chmod + edit and a
retargeted symbolic link remain eligible.

T22: a diff whose text contains U+FFFD (bytes that were not valid UTF-8 when
the host decoded git's output) is not eligible — the patch would write the
replacement character back (`hunk-patch-builder` T8).
