# Stage hunk eligibility

BDD coverage for the centralized rules that decide whether a hunk may show a
Stage button.

T13: the unstaged modification of a staged new file (`AM`) is eligible — the
Changes section shows it as an index → working-tree diff
(`diffview-section-views`); `AD`, `AA` and `RM` are not.
