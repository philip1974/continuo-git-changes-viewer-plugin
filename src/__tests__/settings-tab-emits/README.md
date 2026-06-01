# Settings Tab Emits

The Settings tab writes the manifest-id settings blob first, then emits the new
interval on the plugin SettingsBus. It also subscribes to the bus so multiple
settings-tab instances stay in sync.

- T6: successful radio change writes and emits.
- T6.5: external bus emits update the selected radio.
- T7: write failure rolls back, shows a toast, and does not emit.
