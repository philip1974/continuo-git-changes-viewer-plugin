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
  .git/hooks/planted` writes into the git directory; the plugin drops those
  entries, and stage / unstage / discard / diff for such paths are refused
  without spawning any process.
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
