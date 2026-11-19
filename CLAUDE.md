# CLAUDE.md

## Role

You are working on the Continuo Git Changes Viewer plugin, a third-party
Continuo plugin repository. Treat this repository as renderer-side plugin code
behind the Continuo plugin SDK boundary.

## Hard Lines

1. Git writes are limited to the explicit, user-initiated operations shipped
   since v0.3: stage / unstage / discard (hunk and file level), commit and
   amend. Destructive ones go through the preview drawer / confirmation flow.
   Do not add other mutating behavior (stash, checkout of branches, reset,
   clean, push, fetch, ...) and never mutate the repo from background refresh
   or read paths.
2. All git execution goes through `gitExec` (`src/git/exec.ts`) on top of
   `app.shell.exec`, which carries the hardening arguments (hooks disabled
   except for commit, no network protocols, safe config overrides). Do not
   import Node process, filesystem, or child-process APIs in production source.
3. Large diffs must degrade to the existing placeholder path instead of trying to
   load or render everything.
4. Every git invocation must keep `GIT_OPTIONAL_LOCKS=0` and
   `--no-optional-locks` in the chain.
5. Treat the opened folder as untrusted: keep the repo-safety / repo-hooks
   checks fail-closed, and never read working-tree files through symbolic
   links (see `src/__tests__/diff-symlink-guard/`).

## Repository Boundary

All code changes for this plugin belong in this repository:
`~/Desktop/continuo-git-viewer-plugin/`.

Do not modify `~/Desktop/Continuo/src/` for this plugin. If a host SDK feature is
missing, keep the plugin degraded and queue follow-up work in the main repo
dev-loop.

Do not write to `~/Desktop/ContinuoWiki/`. If broader design notes are needed,
ask the human owner to update the wiki.

## Development Flow

This plugin follows the same dev-loop discipline as the Continuo main repo:

- Read the relevant implementation and tests before changing behavior.
- Write BDD/TDD coverage for observable changes under `src/__tests__/`.
- Run `pnpm bdd:index`, `pnpm check-web-compat`, `pnpm check-no-skip`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build` before handoff.

## UI And SDK Notes

The panel is opened through the ribbon action, More Actions, or command
surfaces. Jump-back opens the file in the Continuo editor through
`app.editor.openFile` and falls back to an inline banner when the host SDK does
not expose it.

Use `src/styles/index.css` variables and local classes. Do not depend on the
main repo design system or Tailwind utility colors.
