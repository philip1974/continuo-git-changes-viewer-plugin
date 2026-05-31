# AGENTS.md

## Scope

This is the standalone Continuo Git Changes Viewer plugin repo. Keep all plugin
work inside `~/Desktop/continuo-git-viewer-plugin/`.

## Hard Lines

- Git behavior is read-only: no stage, discard, commit, stash, checkout, reset,
  or clean.
- Production source must use the Continuo SDK boundary, especially
  `app.shell.exec` for git.
- Keep `GIT_OPTIONAL_LOCKS=0` and `--no-optional-locks` on git calls.
- Large diffs must use the placeholder/degraded path.
- Do not add a ribbon action in v0.1.
- Jump-back remains an inline banner until the host SDK adds editor navigation.

## Workflow

Use BDD/TDD for behavior changes. Before handoff, run:

```bash
pnpm bdd:index
pnpm check-web-compat
pnpm check-no-skip
pnpm typecheck
pnpm test
pnpm build
```

Do not modify `~/Desktop/Continuo/src/` or write to `~/Desktop/ContinuoWiki/`
from this repo.
