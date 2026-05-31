# Git Exec Wrapper

The git viewer is read-only. Every git call must go through the plugin shell
SDK with both protections enabled:

- `git --no-optional-locks ...`
- `GIT_OPTIONAL_LOCKS=0`

T1 verifies argv and env are injected.
T2 verifies caller env is preserved while enforcing `GIT_OPTIONAL_LOCKS=0`.
