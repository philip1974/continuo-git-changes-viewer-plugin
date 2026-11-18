# notify-refused

When Continuo disables the plugin or revokes its permissions while the panel is
open, `app.notifications.show` itself throws synchronously
(`PERMISSION_DENIED`, the host's live-UI check). The plugin usually reports a
failure from a `catch` branch; if the report throws again, the rejection is
left unhandled and whatever came after the notification (refreshing the list,
closing the drawer, …) is skipped. So every notification goes through
`tryNotify` (`src/lib/notify.ts`): it never throws; a refused notification is
logged to the console and the caller falls back the same way as when the host
has no notification API at all.

`notify-refused.spec.tsx` (every case: `show` throws, no unhandled rejection):

- CommitEditor
  - N1: `git commit` refused → "Commit failed: <reason>" in the banner, commit
    count back to 0, message kept.
  - N2: a warning (repository changed) → in the banner.
  - N3: commit succeeded → "Committed: …" in the banner, editor cleared.
  - N4: amend left HEAD unchanged → "HEAD unchanged" in the banner.
  - N5: checking Amend, reading HEAD refused → Amend off, error in the banner.
- GitViewerPanel
  - N6: Stage refused → error in the banner, write count back to 0.
  - N7: Stage succeeded → "Staged …" in the banner, list refreshed.
  - N8: Discard file succeeded → list still refreshed, "Discarded …" in the
    banner.
- DiffView
  - N9: Discard hunk refused → drawer shows the error (Retry), banner too.
  - N10: Discard hunk succeeded → list still refreshed (the "Hunk discarded"
    toast has no banner fallback, as before).
- SettingsTab
  - N11: saving the interval failed → choice reverted, failure logged.
- Plugin onload
  - N12: fs scope denied → `scopeReady` settles as `deny` (not `error`, not
    rejected), warning in the banner.
