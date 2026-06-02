# Continuo Git Changes Viewer

Git working tree viewer for Continuo. It shows workspace changes in a panel,
with a file list on the left and a diff view on the right.

## Install

This v0.1 build is for manual development installs only. It is not published in
the Continuo plugin catalog.

```bash
pnpm install
pnpm build
bash scripts/dev-install.sh --dev
```

Use `--all` to install into both packaged Continuo and `pnpm dev` userData, or
`--uninstall` to remove the copied plugin.

Restart Continuo after installing. The script copies `manifest.json`, `dist/`,
and `README.md`; it does not symlink the repository.

## Usage

Open a git workspace where the Continuo workspace root is also the git toplevel.
Then open the panel from More Actions -> "Git Changes Viewer".

The plugin does not register a ribbon action in v0.1. Use the command palette or
More Actions command surface to run "Refresh Git Changes".

## Hunk Operations

Modified text files in the Changed section show Stage and Discard buttons on
each unified diff hunk header. Stage opens a PreviewDrawer with the exact patch
that will be applied to the Git index; the hunk is staged only after confirming
in that drawer.

Discard is destructive. It reverse-applies the selected unstaged hunk to the
working tree with `git apply --reverse`, and the drawer requires typing
`discard` exactly before the button is enabled. Uncommitted working-tree changes
cannot be recovered by Git after discard unless you stashed or committed them
first. Use `git stash` first if uncertain.

Staged text files show an Unstage button on each hunk header. Unstage affects
the Git index only; it does not discard working-tree content.

## v0.1 Limits

- Hunk stage, unstage, and discard are supported for modified text files only.
  Added, deleted, renamed, copied, binary, and untracked files do not expose
  hunk write buttons in this version.
- There is no commit or stash UI.
- Jump-back currently shows an inline panel banner with a `path:line` hint. A
  future v0.2 SDK expansion is expected to add real editor navigation.
- The workspace root must be the git toplevel. Opening a subdirectory of a repo
  is reported as unsupported in this version.
- Very large diffs degrade to a file-level placeholder with the exact git
  command to run manually.
