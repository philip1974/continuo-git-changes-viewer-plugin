# Auto Refresh Timer

The polling timer is a plugin-owned lifecycle helper. It starts only at safe
intervals, prevents overlapping ticks, and rate-limits repeated error reports.

- T1: start creates an interval and stop clears it.
- T2: start is idempotent and replaces an existing interval.
- T3: intervals below two seconds are rejected.
- T4: an in-flight tick blocks re-entry.
- T5: repeated matching errors are deduped for sixty seconds.
- T5b: distinct error messages are reported independently.
