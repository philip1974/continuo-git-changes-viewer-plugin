

Working-tree stamp. Editing an unstaged file again leaves its status letters
unchanged, and status output has no id for working-tree content, so the
status fingerprint (`status-hash`) cannot notice it. A Changes / untracked
diff therefore records `worktreeStamp` — kind, size and mtime from
`app.fs.lstat` (the link itself, never its target; nothing is read) — taken
before the file is read. The auto-refresh tick compares it with the file's
current stamp (`auto-refresh-wiring` T19).

- T13: Changes / untracked diffs carry the stamp, taken before `cat`; Staged
  diffs have none; a link is stamped as a link, a missing file as `missing`.
- T14: no stamp when it cannot be taken (no `app.fs`, scope error, unsafe
  path); the diff is still returned and never reported stale.
- T15: `isWorktreeDiffStale` is true only when the diff has a stamp and the
  file now has a different one.
