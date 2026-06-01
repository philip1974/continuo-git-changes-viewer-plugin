# Settings Bus

The settings bus is a plugin-instance, single-event bus for auto-refresh
interval changes. It is not a general event emitter.

- T1: emit notifies a subscribed listener.
- T2: emit notifies multiple listeners.
- T3: a throwing listener is isolated and warns.
- T4: dispose clears listeners.
- T4.5: subscribing after dispose returns a no-op disposable.
- T5: emit after dispose is a no-op.
