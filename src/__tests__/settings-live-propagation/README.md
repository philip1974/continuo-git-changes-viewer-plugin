# Settings Live Propagation

The visible Git Viewer panel responds to SettingsBus interval changes without
requiring close/reopen. The timer starts only after persisted settings load, and
the status hash survives interval-only restarts.

- T8: bus emit while visible restarts the timer at the new interval.
- T9: bus emit Off stops polling.
- T10: bus emit while hidden stores state but does not start polling.
- T11: showing the panel after a hidden emit starts with the latest interval.
- T11.5: mount uses persisted settings instead of a temporary default.
- T12.5: equal hash after interval change skips refresh.
