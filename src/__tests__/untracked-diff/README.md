# Untracked Diff

Untracked files are not shown by `git diff HEAD -- <path>`. The viewer uses
`git diff --no-index --binary --no-color /dev/null <path>` and treats exit code
1 as a successful diff because `git diff` returns 1 when differences exist.

- T1: untracked exit code 1 is accepted.
- T2: truncated untracked output becomes too-large.
