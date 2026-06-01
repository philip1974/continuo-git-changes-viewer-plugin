# Disposables Cleanup

The plugin owns the polling timer and settings-tab registration. Plugin unload
must dispose both even if an opened dockview panel is still mounted.

- T17: onunload stops the plugin-owned timer.
- T18: onunload disposes the settings tab registration.
