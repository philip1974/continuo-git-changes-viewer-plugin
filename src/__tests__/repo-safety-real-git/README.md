# Repo Safety — real git integration

Builds throwaway repositories with a real `git` binary whose config points each
executable setting at a script that drops a marker file, then drives the
plugin's git helpers.

Config-defined hooks (new in git 2.54; the per-event switch in 2.55). The
verdict assertions run on every git; the "it really executes" / "the switch
really stops it" halves run only when the git under test documents the keys
(`git help --config`). Verified by running this suite with git 2.56.1 on
`PATH` in addition to the system git 2.50.1:

- R46: `[hook "evil"]` in `.git/config` → restricted (`hook.evil.event`,
  `hook.evil.command`), guarded ops run nothing, `detectRepoHooks` → present.
  git ≥ 2.54: `git -c core.hooksPath=/dev/null add` does execute it. git ≥
  2.55: with the guard absent, the fixed `-c hook.<event>.enabled=false`
  arguments alone keep every plugin read / write op from executing it.
- R47: the same hook in the user's global config → trusted, no commit prompt;
  git ≥ 2.55: plain `git add` runs it, the plugin's stage / unstage / discard /
  refresh do not.

- R1: fixture sanity — plain `git status` does run the hostile clean filter.
- R2: hostile filter/textconv/diff.external/gpg+showSignature/fsmonitor → the
  repo is restricted; status/diff/show/log/add/commit through the plugin leave
  no marker.
- R3: an executable setting pulled in through `include.path` is detected.
- R4: without the guard, the hardened argv alone neutralizes textconv,
  diff.external, signature verification and fsmonitor while diffs stay correct.
- R5: a nested repository with its own hostile filter is not recursed into.
- R6: an ordinary repository keeps working (status, diff, stage, commit) and the
  user's own pre-commit hook still runs.
- R7: fixture sanity — with the `core.hooksPath` override stripped, planted
  `.git/hooks` fire on stage / unstage (restore and reset) / stage-hunk /
  unstage-hunk (`post-index-change`) and discard-file (`post-checkout`).
- R8: same planted hooks, config trusted: every plugin write op and refresh
  runs no hook.
- R9: `detectRepoHooks` — samples only or no hooks dir → none, planted hooks →
  present; a confirmed commit still runs pre-commit / post-commit.
- R10: local `core.hooksPath` → present; a linked worktree sees the main
  repository's hooks via `--git-common-dir`.
- R11: `core.hooksPath` from global config only → none.
- R12: `.git/hooks` symlinked to a sibling `evilhooks/` outside the workspace,
  with a host-like scoped fs (realpath before scope check, IPC errors carry only
  the message) → unknown; with a scope covering the target → present; git
  really follows the link and runs its pre-commit.
- R13: host-like scoped fs: samples only / missing hooks dir → none.
- R14: partial clone whose repo config sets `protocol.file.allow=always` and a
  marker `remote.origin.uploadpack`; with `GIT_NO_LAZY_FETCH` removed (git <
  2.45) the plugin's `show` is still refused (`transport 'file' not allowed`);
  removing `GIT_ALLOW_PROTOCOL` too lets the fetch run the uploadpack (proves
  `-c protocol.allow=never` alone is bypassed).
- R15: `repo/.git` is a gitfile pointing at a git directory whose name has a
  trailing space / trailing tab / leading space (git keeps all but the newline)
  and contains planted hooks → `detectRepoHooks` reports present (plain and
  host-scoped fs); git really runs that directory's pre-commit.

Redirection outside the workspace (no program is executed; each case first
proves the leak or the outside write with the guard absent):

- R16: `core.worktree` pointing at an outside directory → unguarded diff shows
  the outside file and discard overwrites it; guarded → restricted, outside
  file untouched.
- R17: `core.worktree` in `config.worktree` (`extensions.worktreeConfig`) and
  `core.bare=true` → restricted.
- R18: working tree redirected with no local key at all (`GIT_WORK_TREE`, only
  to isolate the layout check from the key list) → restricted.
- R19: `.git` is a gitfile pointing at another private repository → unguarded
  shows its file content and commit message; guarded → restricted (plain and
  host-scoped fs).
- R20: `.git/commondir` pointing outside; `.git` symlinked to another
  repository → restricted.
- R21: `.git/index` symlinked to another repository's index plus alternates →
  unguarded leaks; unguarded stage rewrites the outside index; guarded →
  restricted.
- R22: deep ref symlink plus object fan-out symlinks, all top-level entries
  regular → unguarded leaks; guarded → restricted.
- R23: `objects/info/alternates` alone does not leak (object ids unknown) but
  is restricted; with one deep ref symlink it leaks.
- R24: `logs/HEAD` and deep `logs/refs/heads/main` symlinked to outside files →
  unguarded commit appends a reflog line carrying the repository-controlled
  `user.name`; guarded → restricted, files untouched.
- R25: `.git/config` symlinked outside → restricted.
- R25b: `.git/COMMIT_EDITMSG` symlinked outside → unguarded commit overwrites
  the outside file with the message; guarded → restricted.
- R26: file access unavailable or scope not granted → restricted.
- R27: layouts that stay trusted — plain repository through a host-scoped fs
  with a non-canonical temp path, symlinked `hooks`, empty alternates file,
  `git init --separate-git-dir` inside the workspace, main repository that
  owns a linked worktree.
- R28: legitimate layouts that become restricted (documented trade-off) —
  linked worktree and submodule whose git directory is outside the workspace,
  bare repository, subfolder of a repository.
- R29: a folder that is not a git repository is not restricted; detection
  still reports not-git-root.
- R30: keys judged non-redirecting (mailmap.file, diff.orderFile,
  commit.template naming an outside file) stay trusted and nothing of that file
  is shown or committed.
- R30b: `core.attributesFile` naming an outside file → git's stderr carries
  words of it (`<word> is not a valid attribute name: <file>:<line>`), shown
  with the guard absent; `core.attributesFile` / `core.excludesFile` in the
  repository config → restricted, nothing of the file reaches the plugin.
- R31: `probeRepoSafety` reports reason `unsafe-layout`.

Nested repositories (a gitlink in the outer index is enough, no `.gitmodules`;
the nested repository's own config is never inspected, so no plugin git command
may spawn a process inside it):

- R32: outer `diff.submodule=diff` + nested repository with `diff.external` /
  filters whose HEAD differs from the gitlink → with the pin and the flag
  stripped, listing and auto-selecting ` M sub` executes the nested config;
  with either `-c diff.submodule=short` or `--submodule=short` nothing runs and
  the diff still shows the `Subproject commit` change; the guard also restricts
  the repository (`diff.submodule`).
- R33: with `GIT_TRACE=1`, every plugin operation (status, status hash, diffs,
  head meta, hooks detection, stage / unstage via restore and reset / discard
  of the gitlink, commit, amend, plain `status`, `log -p`) on a repository
  that also sets `status.submoduleSummary`, `diff.ignoreSubmodules=none` and
  `submodule.sub.ignore=none` logs no `run_command` at all; with the submodule
  hardening stripped the same run spawns `git status` inside `sub/`,
  `git submodule summary` and `git maintenance run --auto`.
- R34: `-c diff.ignoreSubmodules=dirty` is outranked by
  `submodule.<name>.ignore=none` (the nested repository's `core.fsmonitor`
  program runs); the plugin's
  `--ignore-submodules=dirty` flag is not.

Commit and the network (a hook-less Commit shows no confirmation):

- R35: partial-clone config with an `ssh://` promisor remote, `core.sshCommand`
  and a staged change whose old blob is missing → with `--quiet` and the
  network block stripped, Commit executes `core.sshCommand`; the plugin's
  commit and amend run nothing and succeed, and the repository stays trusted
  (blobless clones are common). Each defense alone also prevents execution
  (`--quiet` alone succeeds; the block alone leaves git exiting 128 after
  creating the commit).
- R36: same with an `http://` promisor remote (local server answering 401) and
  a local `credential.helper=!cmd` → no request, no helper.
- R37: a pre-commit hook records its environment: unconfirmed commit →
  `GIT_ALLOW_PROTOCOL=""`, `GIT_NO_LAZY_FETCH=1`, `protocol.allow=never`;
  confirmed commit → none of them.
- R38: after confirmation the transport is reachable again (the user agreed to
  run repository code); the same commit without confirmation is not.

Literal paths (also affects ordinary repositories):

- R39: tracked files named `*` and `:(glob)**` → without
  `GIT_LITERAL_PATHSPECS` staging that one file stages everything and
  discarding it discards every change; with it stage / unstage (restore and
  reset) / discard touch only that file.
- R40: `[id].tsx` no longer matches `i.tsx` (stage, diff, staged diff).
- R41: no side effects elsewhere — untracked directory staging, hunk apply,
  head meta, safety probes; a pre-commit hook still uses glob pathspecs.

Paths reported by git:

- R42: a forged `.git/index` listing `../outside.txt`, an absolute path and
  `.git/hooks/planted` → git lists them as changes and `git checkout --
  .git/hooks/planted` writes into the git directory; the parser drops those
  entries, the status scan as a whole rejects with `UnsafeIndexError`, and
  stage / unstage / discard / diff for such paths are refused without spawning
  any process.
- R42b: the forged entries are staged, so a commit made without the check
  writes `../outside.txt` and `.git/hooks/planted` into the tree; the status
  scan rejects with `UnsafeIndexError`, and after `guard.restrict` the commit
  is refused and HEAD does not move.
- R60: `..\x`, `a:b`, `c:notes.txt` staged with plain git, plus an untracked
  `d:untracked` → listed as inoperable rows; stage / unstage / discard / diff
  for them start no process; the plugin's commit succeeds and the paths in the
  commit are exactly the rows the Staged section showed.
- R43: `status.renames=copies` makes git emit copy records; with the plugin's
  pinned rename detection the list is the same whatever the repository
  configures (`copies`, `false`), and with the pins stripped the copy record is
  still parsed without producing a bogus entry.

Config enumeration (see `doc/git-config-classification.md`):

- R44: a repository setting colour to `always`, custom diff prefixes, zero
  context, `i18n.logOutputEncoding=UTF-16`, `i18n.commitEncoding`, status /
  log presentation keys, `apply.ignoreWhitespace` → stays trusted and the
  parsed status, diff and HEAD message are identical to a default repository;
  hunk staging works; the commit carries no wrong `encoding` header. With the
  output pins stripped the diff has ANSI escapes, no `a/` `b/` prefixes and
  zero context, and the message is not UTF-8.
- R45: program-valued keys outside the restricted list (pager, editor, alias
  shadowing built-ins, ssh / credential / proxy without a fetch, help / man /
  browser / difftool / mergetool commands, local `trace2.*Target`) → stays
  trusted, and status / diff / every write op / commit / amend start none of
  them; the same `trace2` key in global scope does write (fixture proof).

File names that look like revision syntax:

- R50: files named `a..b` (with a path `a` and a branch `b`), `a...b`,
  `a@{1}`, `a^{tree}`, `a~1`, `a^`, `:(top)x`, `:x`, `-x`, `-n`, `--help`,
  `ab:c`, `@{u}`, `a b`, `d/e..b`, `中文 文件.txt`, `d/名字 带 空格.md` → the
  original pane is the HEAD blob of exactly that path. (`a:b` looks like a
  drive-relative path and is an inoperable row instead: R60.)
  `git show HEAD:a..b` (the earlier command) prints branch `b`'s commit log.
- R51: a path that is a directory in HEAD or absent from it → empty original
  (`cat-file blob` fails; no tree listing).
- R51b: a gitlink whose nested repository moved → empty original, the change
  is shown as a `Subproject commit` diff, nothing of the nested repository is
  read.
- R51c: a symbolic link in HEAD → the original is the link target text git
  stores (for a link to a file outside the folder: its path, never its
  content); the working-tree side is withheld.

Large files (host-like output cap: 10 MiB unless the call sets its own):

- R57: a 3 MiB tracked file with a one-line change → complete diff; both
  whole-file reads stop at 1 MiB (`modifiedTruncated`). An untracked 3 MiB
  file → its first 1 MiB, flagged; a file of exactly 1 MiB → not flagged.
- R58: a change whose diff exceeds 10 MiB → `too-large` placeholder with the
  command; status and staging still work.

Keys the viewer has not reviewed (`repo-safety` K1–K10 with the real `git help
--config`; also run with git 2.56.1):

- R48: every key the installed git documents is restricted or in the reviewed
  table, except `submodule.<name>.gitdir` (git ≥ 2.56, left unreviewed),
  `extensions.*` / `feature.*` names outside the reviewed ones, and
  keys newer than the newest reviewed list; each of those, set in the
  repository, yields `unknown-config`.
- R49: private keys of gh / VS Code / git-flow / git-lfs / git-svn / git-town /
  Git for Windows in `.git/config` → trusted, status / stage / commit work;
  `GIT_TRACE` shows `git help --config` ran as a built-in and spawned nothing
  although `pager.help`, `help.format=web`, `browser.*.cmd`, `man.*.cmd` and
  `alias.help` were set.

Key splitting (`repo-safety` C1–C8 against a real git):

- R52: a filter driver named `""` (`[filter ""]`, selected by `* filter=`),
  named with U+2028, or with a dotted name → plain `git status` runs its clean
  command; the repository is restricted (`filter..clean`, …) and guarded ops
  run nothing. (Before the fix the whole-key regex `^filter\..+\.clean$`
  missed the first two and the repository was trusted.)
- R53: `[remote "a.uploadpack"] url`, `[branch "x.remote"] merge`, `[branch
  ""] description` → trusted, status / stage work; `[remote "a.url"]
  uploadpack` → restricted.
- R54: the overlap snapshot (`repo-safety` C6) computed from the installed
  git's own `git help --config`.

Extensions (`repo-safety` K12–K13):

- R55: `extensions.refStorage=files://<outside dir>` → restricted on every git
  (`unsafe-config` where git accepts the value; `probe-failed` on git 2.50,
  which rejects it and fails every command), guarded ops write nothing. Where
  git accepts it (2.56.1): an unguarded commit creates `HEAD` and `logs/HEAD`
  (with the repository's `user.name`) in the outside directory, and pointing
  it at another repository lists that repository's branch names.
- R56: sha256 and reftable repositories with `extensions.worktreeConfig` →
  trusted, status / stage / commit work; `extensions.futureThing` in a
  version-0 repository (git ignores it) → `unknown-config`; the same name and
  a new `feature.*` preset in global config → trusted.

Fixed arguments on an older git (the system git 2.50.1 knows neither `hook.*`
nor the per-event switch; also run with 2.56.1):

- R59: safety probes (including `git help --config`), refresh (status,
  numstat, hash, diff, HEAD message), stage / unstage / discard at file and
  hunk level, commit and amend through a recording `shell.exec`: every git
  call exits 0 with an **empty stderr** — the 28 `-c hook.<event>.enabled=false`
  switches and every other pin are accepted silently — and each parsed result
  (status codes, diff shape, HEAD message / subject / sha, index and
  working-tree state) is right. Every non-commit call carries all 28 switches,
  commit carries none. The `restore -h` capability probe exits 129 on git
  before 2.5x and 0 after; either way `restore --staged` is what runs (before
  the fix only 0 counted, so 2.50.1 always took the `reset HEAD --` fallback).
- R59b: `-c hook.<event>.enabled=false` for a real and for a made-up event
  name → `git status` exits 0 with empty output on a git that knows the key
  and on one that does not.

Staged content (`diff-fetcher` T6–T7): the Staged section shows the index
version, read with `git cat-file blob :0:<path>`.

- R61: `A ` / `AM` / `AD` / `MM` / `RM` → the staged view's new side equals
  `git cat-file blob :0:<path>` for each (`AM`: "staged", not the later
  "other"; `AD`: the staged text, not "(empty file)"); the unstaged view of
  the same files still carries the working-tree file.
- R61b: after staging, the path becomes a symbolic link to an outside file, a
  directory, or disappears → the staged view is unchanged (it never touches
  the working tree); the unstaged view of the link is still withheld.
- R61c: a staged symbolic link shows the stored target path, not the target's
  content; a staged gitlink and an unmerged `AA` path have no stage-0 blob →
  `withheld: 'no-staged-blob'`.
- R62: the R50 names plus `0:x`, `2:x`, `0:0:x` next to `x`, staged as new
  files and then edited → each staged view is that file's own index blob
  (`:0:x` alone would read `x` for the file named `0:x`).

Unreadable status (`status-unavailable`):

- R63: a corrupt `.git/index` hiding staged content → `git status` exits
  non-zero and `scanStatus` rejects with `StatusUnavailableError` (`git status
  failed (… index …)`); it used to resolve to an empty list. With the index
  restored the staged file is listed again.
- R63b: in a restricted repository the guard's refusal of `status` surfaces
  the same way (and nothing runs).

Read timeout (`diff-fetcher` T8–T9):

- R64: the path is a FIFO by the time `cat` opens it (file-type check raced) →
  the read is terminated after `FILE_READ_TIMEOUT_MS` (5 s) rather than the
  host default of 30 s, and the result carries `modifiedTruncated` +
  `modifiedTimedOut`.

Config scopes (`repo-safety` T3–T3b, T7b–T7c; run with git 2.50.1 (Apple) and
2.56.1):

- R65: with a real system file (+ include), `$XDG_CONFIG_HOME/git/config`,
  `~/.gitconfig` (+ include), local config (+ include), `config.worktree`,
  `-c`, `GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS`, each key is reported in
  the expected scope (`system` / `global` / `local` / `worktree` / `command`;
  includes inherit). No other scope name appears except Apple Git's `unknown`
  (its bundled defaults), whose keys are all reviewed. The user's files are
  full of program-valued keys; the repository is trusted, status / stage work
  and none of those programs is started.
- R65b: a plain repository under the real system configuration → `trusted`,
  cacheable; the same kind of key in the repository → restricted.

File names byte for byte (`exec` T13; run with git 2.50.1 (Apple) and 2.56.1;
the "without the pin" proofs only run where git rewrites arguments, i.e.
macOS):

- R66: repository config `core.precomposeUnicode=true`, index entry with an
  NFD name, state `MM` → the Staged view is its index blob (not
  `no-staged-blob`), both diffs are non-empty, file-level stage / unstage
  (`restore` and `reset`) / discard and hunk-level stage / unstage / discard
  act on that entry, no NFC twin appears, and the commit holds what the
  Staged view showed. Without the pin: staged view empty + withheld, and
  `add` creates an NFC twin.
- R67: an ordinary repository whose files have decomposed names on disk
  (accented Latin, Hangul jamo): exactly one row per file (no phantom `??`
  for the tracked one — `status` keeps the repository setting), tracked file
  view / stage / unstage / discard work, the untracked file is staged under
  the name `status` reported (`untracked: true`), then `AM` → stage → unstage
  round-trips. With the pin applied to the untracked `add`, git exits 0 and
  stages nothing.
- R68: the index holds both the NFC and the NFD spelling (one file on APFS,
  two on a normalization-sensitive file system): each row's view, stage,
  unstage and discard touch only its own entry.

Unreadable staged version (`diff-fetcher` T10):

- R69: with only the index read made to fail, a regular staged file, a staged
  symbolic link and a staged file in a directory are `staged-unreadable`; a
  real gitlink (`ls-files -s` mode 160000) and an unmerged `UU` path stay
  `no-staged-blob`; in a restricted repository the guard's refusal is what is
  reported.

Per-section views (`diffview-section-views`, `diff-fetcher` T11–T12):

- R70: `AM`, `AD`, `MM`, a staged new symbolic link and an untracked file,
  fetched and rendered per section: Staged shows the whole index version for
  new entries and the staged increment for `MM`; Changes shows the index →
  working-tree increment (`AM`, with Stage / Discard hunk buttons that work
  against real git), the deletion for `AD` (no "(empty file)"), and the whole
  file only for the untracked one; the link is labelled "Symbolic link →
  <target>" and the outside file's content never appears.

One path, two records (`git-store-mode-selection` T20–T23, P1):

- R71: after `git rm --cached f.txt` the list has `D  f.txt` and `?? f.txt`;
  through the store, the untracked row yields the file on disk
  (`isUntracked`), the staged row the deletion diff; a refresh keeps the
  untracked row selected; staging the untracked row removes both records.

Type changes (`status-scanner-xy` T15, `hunk-patch-builder` T5–T7,
`can-*-hunk` T20–T21, `can-file-ops` T30; run with git 2.50.1 and 2.56.1):

- R72: `AT`, ` T` (file → link and link → file), `T ` and `MT` keep their
  codes; the Changes / Staged views show both halves (deletion + addition)
  with no hunk buttons, and no hunk patch can be built from them; file-level
  stage / unstage / discard replace the entry and keep its content (the staged
  blob of `AT` is never emptied); chmod + edit keeps working Stage / Unstage /
  Discard hunk actions that touch content only.

Shown = what a commit takes (`status-hash` T6, `git-store` T7–T8,
`diff-fetcher` T13–T15, `auto-refresh-wiring` T19–T20; run with git 2.50.1 and
2.56.1):

- R73: two staged files are edited and staged again — `git status
  --porcelain` (v1) is byte-identical, the v2 fingerprint is not — and after
  one auto-refresh tick the selected Staged row and the one looked at earlier
  both show the second version. An unstaged file edited again (still ` M`) is
  noticed through the shown diff's working-tree stamp; a row that is not
  selected is read again when clicked, also between two ticks. The commit
  holds exactly what the Staged rows showed.

Submodule entries (`hunk-patch-builder` T5, `discard-file-shell` T12–T13; run
with git 2.50.1 and 2.56.1):

- R74: ` M sub` and `AM sub2` show the gitlink change (`index … 160000`,
  `Subproject commit …`) without hunk buttons, and no hunk patch can be built
  — a patch put together the old way is "applied" by git with exit 0 and
  changes nothing. File-level Stage / Unstage act on the entry; file-level
  Discard answers that the entry is a submodule instead of running a checkout
  that does nothing and reporting success. R33 keeps proving that `checkout
  -- sub` itself starts no process in the nested repository.

The real panel against real git (`panel-real-git.spec.tsx`: the actual
`GitViewerPanel`, store, scanner, diff reader and fingerprint, with the timer
driven by the test; run with git 2.50.1 and 2.56.1):

- P1: staged v1 is shown → the panel is hidden → the file is edited and staged
  again in a terminal → the panel is shown again. It shows v2 at once, with no
  tick, and the commit made from the panel holds what is shown
  (`auto-refresh-wiring` T21).
- P2: auto-refresh off; staged v1 is shown, the file is staged again in a
  terminal, Commit is clicked: nothing is committed, the warning appears and
  the panel now shows v2; the second click commits exactly that
  (`commit-editor-component` T29–T30).
- P3: with nothing changed in between, the first click commits what is shown.
- P5 (content / new file): v1 is shown, a terminal stages something else,
  Commit is clicked; while its fingerprint read is held (the test holds the
  result of that `git status`, no real-time sleeps) the tick lands the new
  list. Nothing is committed, the panel says the view was refreshed after the
  click, and the next click commits what is then shown
  (`commit-editor-component` T36). Before the fix the first click committed
  v2 / `secret.env`.
- P6: a refresh is already in flight at the click (its list read is held):
  nothing is committed and the panel asks to wait (`commit-editor-component`
  T38).

Bytes that are not valid UTF-8 (`hunk-patch-builder` T8, `path-utils` T8,
`status-scanner` T10; run with git 2.50.1 and 2.56.1):

- R75: a text file with a Latin-1 line. A patch put together the old way is
  applied by git with exit 0 and leaves `EF BF BD` in the index (Stage hunk) or
  in the working tree (Discard hunk) where the byte was `E9`. The panel shows
  no hunk button for such a diff in Changes or Staged, builds no patch, and
  says why; file-level Stage / Unstage / Discard keep the bytes exactly.
- R76: an index entry whose name is the Latin-1 bytes `caf\xE9` next to a
  file really named `caf` + U+FFFD: both arrive as the same string. Both rows
  are inoperable, and stage / unstage / discard / diff refuse the name without
  running git — the other file is untouched.

A file-level action acts on the clicked entry, not on a directory at its path
(`worktree-entry`, `discard-file-shell` T14–T17, `stage-file-shell` T6–T8,
`unstage-file-shell` T9–T10; run with git 2.50.1 and 2.56.1):

- R77: Discard. A tracked file replaced by a directory with untracked work in
  it (` D x` — git does not list the untracked file), by a nested repository
  (` T x`), or a tracked `a/b` whose parent `a` became an untracked file:
  `git checkout --` deletes the directory / the file. `discardFile` refuses
  each and nothing is touched; ordinary deleted and modified files are still
  restored.
- R77b: with no file access, or an lstat error other than not-found, nothing
  is checked out.
- R78: Stage. `git add -- x` on the ` D x` row stages `A  x/work.txt` as well;
  `stageFile` refuses. The nested repository is staged as one gitlink entry;
  a deletion below a path that became a file is staged as that deletion.
- R79: Unstage. With `D  x` and `AM x/work.txt`, both `restore --staged -- x`
  and `reset HEAD -- x` unstage the child too; `unstageFile` refuses on the
  `x` row, and works on the child row, on ordinary rows, and on `x` once
  nothing is staged below it.

HEAD (`status-hash` T6c, `amend-component` T35–T38; run with git 2.50.1 and
2.56.1):

- R80: with a new file staged, HEAD is reworded (`commit --amend --only`),
  replaced by a commit made with plumbing, and moved to a new branch — the
  entry lines stay byte-identical each time and the fingerprint changes each
  time. The list scan is unaffected by the header lines.
- R80b: a detached HEAD and an unborn branch have a fingerprint too.
- P4 (real panel): Amend is checked (message of HEAD loaded), HEAD is reworded
  in a terminal, the tick refreshes the panel. Clicking Amend rewrites
  nothing: the terminal's message survives, Amend is turned off and the text
  is kept. Checking Amend again loads the current message and amending then
  works.
- R81: a staged submodule pointer that moves and is staged again (`M  sub`
  both times) changes the fingerprint, and the Staged row then shows the new
  commit. (An unstaged pointer moving again is not visible to status — see the
  residual note in `status-hash`.)

Unmerged paths and intent-to-add (`can-file-ops` T31–T33; run with git 2.50.1
and 2.56.1):

- R82: a merge leaving `AA DD UA AU UD DU UU`. No row offers Unstage or
  Discard. Why: `git restore --staged` on `AA` / `AU` exits 0 and the conflict
  stages are gone (` M` / clean); `git checkout --` on an unmerged path fails.
  Stage on `UD` / `DD` resolves the path; the other conflicts are untouched.
- R83: an intent-to-add entry (` A`) is shown in Changes as its whole content
  with no hunk button and no file-level action.
