# stage-file-shell

BDD coverage for file-level `git add -- <path>` staging.

T5: a row from the Untracked section is added with `untracked: true` — the
`add` keeps the repository's `core.precomposeUnicode` (the name came from git
reading the directory under that setting); tracked rows carry the
`core.precomposeUnicode=false` pin so the argument reaches git unchanged (see
`exec` T13).
