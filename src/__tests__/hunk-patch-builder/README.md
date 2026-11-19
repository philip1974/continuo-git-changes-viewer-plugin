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

T8 — bytes that are not valid UTF-8. The host decodes git's output as UTF-8;
every invalid byte (text in Latin-1, GBK … — git still calls such files text)
becomes U+FFFD. A hunk patch is put together from that decoded text and
written back as UTF-8, so the original bytes are gone: measured with real git,
Stage hunk left `EF BF BD` in the index where the working tree had `E9`, and
Discard / Unstage hunk wrote U+FFFD the same way, all reported as success. A
diff whose text contains U+FFFD is therefore not hunk-patchable
(`hasUndecodableText`), and the diff view says so
(`diffview-hunk-actions` T23). After decoding, an invalid byte cannot be told
from a file that really contains the U+FFFD character (valid UTF-8
`EF BF BD`), so such files lose their hunk actions too — a deliberate,
conservative false positive. File-level actions never pass content through
the plugin and stay byte-exact (`repo-safety-real-git` R75).
