# Unstage hunk eligibility

BDD coverage for M-only unstage eligibility in staged-mode diffs.

T20: a type change (`T` on the index side — file ↔ symbolic link ↔
submodule) is never eligible: git writes it as a deletion plus an addition.

T21: independent of the status code, a diff that `isHunkPatchableDiff`
(`hunk-patch-builder` T5) rejects is not eligible; chmod + edit and a
retargeted symbolic link remain eligible.

T22: a diff whose text contains U+FFFD (bytes that were not valid UTF-8 when
the host decoded git's output) is not eligible — the patch would write the
replacement character back (`hunk-patch-builder` T8).
