# CLAUDE.md

## Role

You are working on the Continuo Git Changes Viewer plugin, a third-party
Continuo plugin repository. Treat this repository as renderer-side plugin code
behind the Continuo plugin SDK boundary.

## v0.1 Hard Lines

1. Git is strictly read-only. Do not add stage, discard, commit, stash, checkout,
   reset, clean, or index-mutating behavior.
2. All git execution goes through `app.shell.exec`. Do not import Node process,
   filesystem, or child-process APIs in production source.
3. Large diffs must degrade to the existing placeholder path instead of trying to
   load or render everything.
4. Every git invocation must keep `GIT_OPTIONAL_LOCKS=0` and
   `--no-optional-locks` in the chain.

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

The v0.1 panel is opened through More Actions or command surfaces. It does not
register a ribbon action. Jump-back is an inline banner, not real editor
navigation, until the host SDK exposes an editor navigation API.

Use `src/styles/index.css` variables and local classes. Do not depend on the
main repo design system or Tailwind utility colors.
