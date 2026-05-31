# Store Load Toast

BDD coverage for v0.1.7 refresh/panel-mount feedback.

The git repo detection error is produced by the store load function, not by
`plugin.onload()`, so the test triggers `store.refresh()`.
