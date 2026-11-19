# AGENTS.md

## Scope

This is the standalone Continuo Git Changes Viewer plugin repo. Keep all plugin
work inside `~/Desktop/continuo-git-viewer-plugin/`.

## Hard Lines

- Git writes are limited to the explicit, user-initiated operations shipped
  since v0.3: stage / unstage / discard (hunk and file level), commit and
  amend. No stash, branch checkout, reset, clean, push or fetch, and no repo
  mutation from background refresh or read paths.
- Production source must use the Continuo SDK boundary; run git through
  `gitExec` (`src/git/exec.ts`, on top of `app.shell.exec`) so the hardening
  arguments stay in place.
- Keep `GIT_OPTIONAL_LOCKS=0` and `--no-optional-locks` on git calls.
- Large diffs must use the placeholder/degraded path.
- Treat the opened folder as untrusted: repo-safety / repo-hooks checks stay
  fail-closed, and working-tree files are never read through symbolic links.
- Jump-back uses `app.editor.openFile`, with the inline banner as fallback.

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
