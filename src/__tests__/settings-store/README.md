# Settings Store

Plugin settings are persisted as one dataStore blob keyed by the plugin manifest
id, not as arbitrary key-value entries.

- T7: missing data defaults to five seconds.
- T7b: corrupt blobs default to five seconds.
- T7c: read failures default to five seconds.
- T8: writes merge the interval into the existing plugin blob.
- T8b: write failures propagate to the caller.
