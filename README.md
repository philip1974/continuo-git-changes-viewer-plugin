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
below a directory of the same name. The same holds upwards: when a file is
staged where a folder used to be, unstaging a row below it would drop that
staged file from the index, unstaging the file's own row would also unstage
the deletions below it, and staging a new file under a path that is still a
file in the index would stage that file's removal. In these cases the action is refused with
an explanation and nothing is changed; resolve it in a terminal. A submodule or
nested repository directory is still staged as the single entry it is — whether
a directory is a repository is git's call (it is asked what `git add` would add
below the path), not the mere presence of something named `.git` inside. The
check happens just before the git command; a change in the instant between
the two is not caught. Each parent folder of the path is checked in turn, so
Stage / Unstage on a path nested more than 64 folders deep is refused (use a
terminal).

## Commit

The top of the panel includes a commit message editor. The Commit button is
enabled only when the message contains non-whitespace text and at least one file
is staged. Messages are passed to Git with `git commit -F -`, so subject/body
formatting and blank lines are preserved.

Commit hooks run normally; this plugin does not pass `--no-verify`. If a hook
fails, the hook output is shown and the message draft stays in the editor. On
success, the plugin clears the draft, refreshes the working tree, and reads the
real subject from `git log -1 --pretty=%s` so commit-msg hook rewrites are
reflected in the toast. If Continuo refuses to run git for the commit (for
example too many git processes running in the window at once), the panel shows
"Commit failed" (or "Amend failed") with the reason and keeps the message.
If Continuo also refuses to show notifications (the plugin was disabled or its
permissions revoked while the panel was open), every message the panel would
have shown as a notification goes to the panel's own banner instead (the
settings tab, which has no banner, only logs it to the console); nothing is
left half-done because of the refused notification.

Right before committing, the plugin checks that the repository is still in
the state the panel last read (the same fingerprint the auto-refresh uses:
`git status --porcelain=v2`, i.e. what is staged). If something changed in
between — for example you staged another edit in a terminal — nothing is
committed: the panel refreshes and asks you to review and commit again. The
same check runs before an amend. If the state cannot be read at all (`git
status` failed or timed out — it has the same time limit as the list), nothing
is committed either and the panel says that the state could not be confirmed
and why; while it stays unreadable the panel shows the reason and Commit /
Amend are disabled until a refresh succeeds. A very short window remains between that
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

The panel's own Stage / Unstage / Discard (file and hunk) and Commit / Amend
do not overlap. While a stage, unstage or discard is running — until its git
command and the refresh after it are done — Commit and Amend are disabled; a
click that slips in anyway, or a stage that ran while the hooks confirmation
was open, commits nothing and asks you to review and commit again. While a
commit or amend is running, the stage / unstage / discard buttons are
disabled, and so are Commit and Amend — also in a panel that was closed and
opened again while the commit was still running (for example during a slow
pre-commit hook): it shows "Committing..." until that commit has finished, and
cannot start a second one. The hooks confirmation itself does not hold the
commit: stage / unstage / discard stay usable while it is open, and confirming
afterwards commits nothing (see above).

### Amend

The commit editor can amend the last commit. Enable "Amend last commit" to load
the current HEAD message into the editor, then edit the message or stage more
changes and click Amend. If you start typing before the message has loaded,
your text is kept instead. Amend runs `git commit --amend -F -`, then refreshes
the panel and clears amend mode on success.

A draft written before checking "Amend last commit" is kept aside: unchecking
Amend (or HEAD's message failing to load, including Continuo refusing to run
git) puts that draft back into the editor. If checking whether there is a last
commit fails, "Amend last commit" stays disabled and its tooltip says why;
Amend mode that is already on can still be unchecked.
Text edited while Amend was checked is not kept when you uncheck it — the draft
from before checking comes back. After a successful amend the editor is empty.

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
  conflict; discarding cannot work); resolve them in an editor or a terminal
  and mark them resolved with `git add` in a terminal. Only the deleted-side
  conflicts (`UD`, `DD`) offer Stage, which marks the conflict as resolved. A
  file added with `git add -N` (intent to add) is shown but has no actions.
- Text that is not valid UTF-8 (Latin-1, GBK, …) is displayed with the
  replacement character `�`. Files whose diff contains it have no hunk
  buttons — a hunk patch could not write the original bytes back — and the
  diff says so; use the file-level actions, which are byte-exact. A file that
  really contains the character U+FFFD is treated the same way. File names
  that are not valid UTF-8, or contain U+FFFD, are listed but cannot be
  operated on. When the last commit's message is not valid UTF-8, Amend with
  the pre-filled message left unedited is refused (amending would replace
  those bytes with `EF BF BD`; so would `git commit --amend --no-edit`): edit
  the message first, or amend in a terminal. An edited message is saved as
  displayed (a warning says so when it is loaded).
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

Error messages and notices that carry git output or text from the repository
(stderr, `core.hooksPath`, hook names) are shown in a visible, single-line,
bounded form: control and format characters (bidirectional controls,
zero-width characters, …) and other default-ignorable code points (variation
selectors, tag characters, Hangul fillers, …) appear as `<U+XXXX>`, line
breaks become spaces, and long text is cut to 500 code points of the shown
text plus an ellipsis (never inside a `<U+XXXX>`, at a grapheme boundary where
possible), so the host's own notification limit never cuts it again. Long
unbreakable text wraps instead of overflowing. The command shown in the "Diff too large"
placeholder is displayed the same way; Copy still copies it exactly (and
reports an error if the clipboard refuses the write). File
names in the file list are shown as they are.
