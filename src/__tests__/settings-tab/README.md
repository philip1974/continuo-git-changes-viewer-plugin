# Settings Tab

The plugin settings tab exposes the auto-refresh interval as an accessible radio
group and persists changes through the manifest-id dataStore blob.

- T14: four radio options render inside a fieldset/legend group.
- T15: changing the radio writes the blob and updates the UI optimistically.
- T16: write failures show a warning notification.
