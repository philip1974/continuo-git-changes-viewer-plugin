# Patience Diff And MergeView

The plugin only ports `patienceDiff.ts` from obsidian-drift. Merge rendering is
a local React wrapper around CodeMirror MergeView.

- T1: patienceDiff keeps equal lines matched.
- T2: patienceDiff marks insertions and deletions.
- T3: MergeView component can render in jsdom without throwing.
