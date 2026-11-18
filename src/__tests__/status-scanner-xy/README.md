# Status scanner X/Y columns

BDD coverage for parsing staged and working-tree columns from
`git status --porcelain=v1 -z`.

T15: the type-change code `T` is kept as-is in either column (`AT`, ` T`,
`T `, `MT`); it is displayed as a modification.
