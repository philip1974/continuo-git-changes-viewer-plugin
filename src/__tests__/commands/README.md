# Commands

v0.1 only registers `git-viewer.refresh`. There is no `git-viewer.open` and no
`git-viewer.jump-back-to-editor` because the current Continuo SDK has neither
dock open/focus nor parameterized command execution.

- T1: registers exactly one command.
- T2: command invokes store.refresh.
