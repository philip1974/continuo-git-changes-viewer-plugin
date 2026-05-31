# Git Viewer Store

The store keeps repo state, file selection, diff cache, loading state, and the
inline banner used for degraded jump-back / large-diff feedback.

- T1: selectFile records the selected path.
- T2: clear resets repo, changes, selection, cache, loading, and banner.
- T3: setBanner/dismissBanner state transition.
- T4: refresh runs the injected loader and replaces repo state.
