# Unstage hunk eligibility

BDD coverage for M-only unstage eligibility in staged-mode diffs.

T20: a type change (`T` on the index side — file ↔ symbolic link ↔
submodule) is never eligible: git writes it as a deletion plus an addition.

T21: independent of the status code, a diff that `isHunkPatchableDiff`
(`hunk-patch-builder` T5) rejects is not eligible; chmod + edit and a
retargeted symbolic link remain eligible.
