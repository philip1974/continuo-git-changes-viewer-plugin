# Main Bus Lifecycle

The settings bus is owned by the plugin instance and passed to both the panel
factory and settings tab render path. Plugin unload disposes the bus.

- TLC1: the panel factory receives the plugin settings bus.
- TLC2: the settings tab render receives the same settings bus.
- TLC3: plugin unload disposes the settings bus.
