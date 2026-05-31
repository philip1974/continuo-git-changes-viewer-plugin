# Repo Detection

v0.1 only supports a workspace whose root is itself the git repository top
level. Detection must use `git rev-parse --show-prefix` rather than comparing
paths, so symlink spelling differences do not false-negative.

- T1: empty prefix means workspace root is the repo top level.
- T2: non-empty prefix means workspace root is a repo subdirectory.
- T3: non-zero git exit means not a git repo.
- T4: symlink-spelled roots still work because git decides prefix state.
