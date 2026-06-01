# Auto Refresh Wiring

The panel subscribes to dockview visibility events and uses the plugin-owned
timer. It compares raw status output before calling store.refresh.

- T9: visible panels start polling on mount.
- T10: hidden visibility events stop polling.
- T10b: visible visibility events restart polling.
- T11: initial raw hash is read without forcing a refresh.
- T12: equal hashes skip refresh.
- T13: changed hashes call refresh.
