# can-discard-hunk

BDD coverage for Changed-section discard hunk eligibility.

T8: `AM` in the Changes section is eligible (same index → working-tree hunk
as `MM`; see `diffview-section-views`); `RM` / `CM` stay disabled.
