# Continuo Git Changes Viewer

Git working tree viewer for Continuo. It shows workspace changes in a panel,
with a file list on the left and a diff view on the right.

## Install

This v0.4 build is for manual development installs only. It is not published in
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

Use the Git Changes ribbon action or More Actions command surface to open the
panel and run "Refresh Git Changes".

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

## File Operations

FileList rows expose whole-file action buttons for cases that hunk patching does
not cover. Untracked rows show Stage only, which runs `git add -- <file>`.
Changed rows with modified or deleted working-tree content show Stage and
Discard. Staged modified, added, or deleted rows show Unstage.

File-level Discard is destructive and requires typing `discard` exactly. It runs
`git checkout -- <file>`, which restores the working tree from the index and
preserves already-staged content for `MM` files. Untracked file deletion is not
supported in v0.4.0.

A row names one entry, but git treats the path as a prefix. When a directory
now sits where a tracked file was (or a file where one of its parent folders
was), Discard would delete that directory or file with everything in it, and
Stage would add every untracked file inside — files the list does not show
while the old entry exists. Unstage would likewise unstage entries staged
below a directory of the same name. In these cases the action is refused with
an explanation and nothing is changed; resolve it in a terminal. A submodule or
nested repository directory is still staged as the single entry it is — whether
a directory is a repository is git's call (it is asked what `git add` would add
below the path), not the mere presence of something named `.git` inside. The
check happens just before the git command; a change in the instant between
the two is not caught.

## Commit

The top of the panel includes a commit message editor. The Commit button is
enabled only when the message contains non-whitespace text and at least one file
is staged. Messages are passed to Git with `git commit -F -`, so subject/body
formatting and blank lines are preserved.

Commit hooks run normally; this plugin does not pass `--no-verify`. If a hook
fails, the hook output is shown and the message draft stays in the editor. On
success, the plugin clears the draft, refreshes the working tree, and reads the
real subject from `git log -1 --pretty=%s` so commit-msg hook rewrites are
reflected in the toast.

Right before committing, the plugin checks that the repository is still in
the state the panel last read (the same fingerprint the auto-refresh uses:
`git status --porcelain=v2`, i.e. what is staged). If something changed in
between — for example you staged another edit in a terminal — nothing is
committed: the panel refreshes and asks you to review and commit again. The
same check runs before an amend. A very short window remains between that
check and git reading the index for the commit (two process starts); a change
landing exactly there is committed without having been shown.

After a refresh the diff you are looking at stays on screen until the new one
has been read; the header shows "Refreshing diff…" meanwhile, and a commit
clicked while a Staged diff is in that state is held back.

The comparison is made with what was on screen when you clicked. A click while
a refresh is in flight is held back ("still being refreshed"), and if a refresh
lands between the click and the comparison — or while the hooks confirmation
is open — nothing is committed and the panel asks you to review and commit
again. What cannot be told apart: a refresh that landed an instant before the
click, so that the new list was on screen (or about to be painted) without you
having had time to read it. The click then commits what the panel shows at
that moment.

### Amend

The commit editor can amend the last commit. Enable "Amend last commit" to load
the current HEAD message into the editor, then edit the message or stage more
changes and click Amend. Amend runs `git commit --amend -F -`, then refreshes
the panel and clears amend mode on success.

Amend only rewrites the commit whose message it loaded. If HEAD has become a
different commit since "Amend last commit" was checked (you committed or
amended in a terminal), clicking Amend changes nothing: Amend is turned off
with an explanation, and checking it again loads the current message.

Amend rewrites local HEAD. If the commit was already pushed, integrating the
rewrite may require a force-push. v0.4.1 shows a visible warning but does not
detect whether HEAD is already on a remote branch.

## v0.4 Limits

- Hunk stage, unstage, and discard are supported for modified text files only
  (including the unstaged edits of a staged new file, `AM`, in Changes).
  Added, deleted, renamed, copied, binary, and untracked files do not expose
  hunk write buttons in this version.
- File-level actions in v0.4.0 are intentionally narrow: Untracked can be
  staged; Changed M/D can be staged or discarded; Staged M/A/D can be unstaged.
  Rename/copy rows do not expose file-level action buttons yet.
- Commit is intentionally narrow in v0.4.1: signoff, author override, commit
  signing, hook bypass, amend push detection, and stash UI are not supported.
- Jump-back currently shows an inline panel banner with a `path:line` hint. A
  future v0.2 SDK expansion is expected to add real editor navigation.
- Files whose names are not portable (`c:notes.txt`, a name containing `..\`)
  are listed but cannot be viewed, staged, unstaged or discarded here. If one
  is already staged the row says so, because a commit will include it.
- Files with an unresolved merge conflict are listed with a CONFLICT badge.
  They have no Unstage or Discard here (unstaging would silently drop the
  conflict; discarding cannot work); resolve them in an editor or a terminal.
  Where Stage is offered on such a row it marks the conflict as resolved. A
  file added with `git add -N` (intent to add) is shown but has no actions.
- Text that is not valid UTF-8 (Latin-1, GBK, …) is displayed with the
  replacement character `�`. Files whose diff contains it have no hunk
  buttons — a hunk patch could not write the original bytes back — and the
  diff says so; use the file-level actions, which are byte-exact. A file that
  really contains the character U+FFFD is treated the same way. File names
  that are not valid UTF-8, or contain U+FFFD, are listed but cannot be
  operated on. Amending a commit whose message is not valid UTF-8 saves the
  message as displayed (a warning says so).
- Auto-refresh notices changes of what is staged, of HEAD, of the list of
  changed files, and of the file whose working-tree diff is on screen. It does
  not notice an unstaged submodule moving to yet another commit (git status
  does not report it); click the row or press Refresh. A staged submodule
  pointer is covered.
- The workspace root must be the git toplevel. Opening a subdirectory of a repo
  is reported as unsupported in this version.
- Very large diffs degrade to a file-level placeholder with the exact git
  command to run manually (the host caps command output at 10 MiB). The file
  name in that command is quoted for POSIX-style shells (sh, bash, zsh, fish);
  it is not written for PowerShell or cmd. A new or
  untracked file is shown in full up to 1 MiB; beyond that the panel shows the
  first 1 MB and says so.

## Untrusted folders: known limitation

Before running git the plugin checks the repository's own config and stops
(showing why) when it contains a setting that runs a program, points git
outside the folder, or that the installed git understands but this plugin has
not reviewed. Repository extensions (`extensions.*`) and `feature.*` presets
pass only by reviewed name. One gap remains by construction: git documents a
few sections only as wildcards (`http.<url>.*`, `credential.<url>.*`,
`bundle.*`, `sendemail.<identity>.*`, `sideband.<url>.*`, `alias.*`,
`pager.<cmd>`), so a variable a future git adds inside one of them is treated
as reviewed. Those sections only act during network transport, mail sending or
when an alias / pager is invoked, none of which this plugin does. Details:
[`doc/git-config-classification.md`](doc/git-config-classification.md).
