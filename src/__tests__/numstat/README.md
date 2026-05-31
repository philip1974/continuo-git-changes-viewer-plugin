# Numstat Binary Detection

`git status --porcelain` does not identify binary files. The viewer uses
`git diff --numstat -z HEAD`; records with `-\t-\t<path>` are binary.

- T1: parses text additions/deletions.
- T2: marks binary records.
- T3: ignores empty trailing NUL records.
