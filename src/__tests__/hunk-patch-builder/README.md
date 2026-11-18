# Hunk patch builder

BDD coverage for constructing a single-hunk patch preview that can be passed to
`git apply --cached` through stdin.

T5–T7: `isHunkPatchableDiff` — a unified diff can be split into hunk patches
only when it is a single `diff --git` section without `new file mode` /
`deleted file mode`, without a non-regular `old mode` / `new mode`, without a
submodule `index … 160000` line and not a combined (`diff --cc`) diff. chmod +
edit and a retargeted symbolic link stay patchable; header words inside file
content do not count; `extractHunkPatchFromUnifiedDiff` returns `null` for a
diff that is not patchable.
