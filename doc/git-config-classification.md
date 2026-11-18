# Git config keys vs. the plugin's command set

Audit of every documented git config key (`git help --config`, git 2.50.1:
954 keys) against the only git commands the plugin runs:

`config --list`, `rev-parse`, `status --porcelain=v1 -z`, `diff` (`--numstat
HEAD`, `-- <path>`, `--cached -- <path>`), `show HEAD:<path>`, `log -1
--pretty=…`, `add -- <path>`, `apply [--cached] [--reverse] -`, `restore
--staged -- <path>` / `reset HEAD -- <path>`, `checkout -- <path>`, `commit
[--amend] -F -`.

Question asked of each key: can a value in the **repository's** config (local /
worktree scope, including included files) make one of those commands start a
process, use the network, enter another repository, read or write outside the
workspace, or change output the plugin parses?

Rule of thumb used in `src/git/exec.ts`: neutralize with a fixed command-line
argument or environment variable wherever git offers one (command scope
outranks repository config, so nothing depends on a blocklist); use the
restricted list (`src/git/repo-safety.ts`, no git command runs at all) only for
keys git gives no switch for.

| Handling | Keys | Count |
| --- | --- | ---: |
| **Restricted** — repository is not operated on | `filter.<drv>.clean/smudge/process`, `diff.<drv>.textconv/command`, `diff.external`, `merge.<drv>.driver`, `gpg.program`, `gpg.<format>.program`, `gpg.ssh.defaultKeyCommand`, `core.askPass`, `core.gitProxy`, `core.alternateRefsCommand`, `uploadpack.packObjectsHook`, `remote.<n>.uploadpack/receivepack`, `protocol.<n>.allow`, `trailer.<k>.cmd/command`, `gc.recentObjectsHook`, `hook.*` (config-defined hooks, git ≥ 2.54), `core.worktree`, `core.bare` (unless false); by value: `core.fsmonitor` (non-boolean), `diff.submodule` (other than short/log); plus git-lfs `lfs.extension.*` / `lfs.customtransfer.*` | 21 |
| **Pinned with `-c`** (every command) | `core.fsmonitor=false`, `log.showSignature=false`, `submodule.recurse=false`, `diff.submodule=short`, `status.submoduleSummary=false`, `maintenance.auto=false`, `gc.auto=0`, `core.protectHFS=true`, `core.protectNTFS=true`, `i18n.commitEncoding=UTF-8`; `fsmonitor.*` (daemon never started) | 12 |
| **Pinned with `-c`** (every command but `commit`, whose `-c` values reach hooks) | `protocol.allow=never` (also on a commit whose hooks were not confirmed), `core.hooksPath=/dev/null`, `hook.<event>.enabled=false` for every githooks(5) event (git ≥ 2.55), `status.renames=true`, `diff.renames=true`, `color.ui=false`, `color.diff=false`, `diff.noprefix=false`, `diff.mnemonicPrefix=false`, `diff.srcPrefix=a/`, `diff.dstPrefix=b/`, `diff.context=3`, `diff.interHunkContext=0`, `diff.suppressBlankEmpty=false`, `diff.relative=false`, `i18n.logOutputEncoding=UTF-8`, `apply.ignoreWhitespace=no` | 16 |
| **Never triggered** — auto-maintenance is pinned off | remaining `gc.*`, `maintenance.*` | 31 |
| **Overridden by a fixed flag** | `diff.ignoreSubmodules`, `submodule.<n>.ignore` (`--ignore-submodules=dirty`; a `-c` would lose to `submodule.<n>.ignore`); `core.pager`, `pager.<cmd>` (`--no-pager`); `diff.trustExitCode`, `diff.<drv>.trustExitCode/cachetextconv` (`--no-ext-diff --no-textconv`); `apply.whitespace` (`--whitespace=nowarn`); `format.pretty` (explicit `--pretty`); `status.branch/short/showStash/aheadBehind/relativePaths/displayCommentPrefix`, `column.*` (`--porcelain=v1 -z`); remaining `color.*` (`--no-color`, porcelain, `commit --quiet`); `commit.status/verbose/template` (`-F -`, no editor) | 104 |
| **Overridden by environment** | `core.editor`, `sequence.editor` (`GIT_EDITOR=:`) | 2 |
| **Network only** — blocked by `GIT_ALLOW_PROTOCOL=` + `GIT_NO_LAZY_FETCH=1` + `-c protocol.allow=never` (every command except a hooks-confirmed commit) | `core.sshCommand`, `ssh.variant`, `http.*`, `credential.*`, `credentialCache.*`, `credentialStore.*`, `url.*`, `remote.*` (rest, incl. `vcs`, `proxy`, `promisor`, `partialclonefilter`), `remotes.*`, `fetch.*`, `transfer.*`, `bundle.*`, `clone.*`, `promisor.*`, `protocol.version`, `lsrefs.*`, `submodule.fetchJobs` / `alternate*` / `<n>.fetchRecurseSubmodules` | 114 |
| **Protected scope** — git ignores the key in repository config | `trace2.*` (system / global only; verified: a local `trace2.*Target` writes nothing), `safe.*` | 13 |
| **Not read by this command set** — belongs to commands the plugin never runs | `am`, `blame`, `branch`, `browser`, `clean`, `completion`, `difftool`, `fastimport`, `format` (rest), `fsck`, `gitcvs`, `gitweb`, `grep`, `gui`, `guitool`, `help`, `imap`, `init`, `instaweb`, `interactive`, `mailinfo`, `man`, `merge` (rest), `mergetool`, `notes`, `pack`, `pull`, `push`, `rebase`, `receive`, `repack`, `revert`, `sendemail`, `showBranch`, `stash`, `submodule` (rest), `tag`, `tar`, `trailer` (rest; no `--trailer`), `uploadarchive`, `uploadpack`, `versionsort`, `web`, `worktree`, `commitGraph`, `bitmapPseudoMerge`; `alias.*` (cannot shadow a built-in); `diff.tool/guitool/dirstat/stat*Width/wordRegex`, `log.follow/showRoot/diffMerges/graphColors`, `pretty.<name>`, `checkout.defaultRemote/guess` | 484 |
| **Read, in-process only** — no process, no network, stays inside the workspace; changes presentation, performance or content conversion at most | remaining `core.*` (autocrlf / eol / safecrlf, fileMode, symlinks, ignoreCase, quotePath, abbrev, compression, sparseCheckout, splitIndex, untrackedCache, sharedRepository, fsync, lock timeouts, …), remaining `diff.*` (algorithm, renameLimit, `<drv>.xfuncname/binary`, orderFile, colorMoved, …), `index.*`, `splitIndex.*`, `sparse.*`, `feature.*`, `extensions.*`, remaining `log.*`, `mailmap.*`, `attr.tree`, `user.*`, `author.*`, `committer.*`, `commit.cleanup`, `commit.gpgSign`, `add.*`, `checkout.workers/thresholdForParallelism`, `rerere.*`, `reftable.*`, `gpg.format/minTrustLevel/ssh.*File`, `status.renameLimit/showUntrackedFiles`, `advice.*`, `include.path`, `includeIf.*` (followed by the config probe) | 157 |

Notes on the last two rows (keys whose names look dangerous):

- `core.excludesFile`, `core.attributesFile`, `diff.orderFile`, `mailmap.file`,
  `gpg.ssh.allowedSignersFile` name files outside the workspace, but git only
  parses them as patterns / mappings and never echoes their content
  (`repo-safety-real-git` R30). Attributes can only select drivers, and every
  driver key that executes is restricted.
- `commit.gpgSign` (with `gpg.format`, `user.signingKey`): the commit runs the
  user's own `gpg` / `ssh-keygen` from `PATH`. The program path keys are
  restricted, and the key id is passed as the argument of `-u` / `-f`, so it
  cannot inject options (verified). Not pinned: that would also disable the
  user's own global signing setup.
- `commit.cleanup`, `core.commentChar`: can only strip comment-like lines from
  the message the user typed.
- `checkout.workers`: parallel checkout helpers are git itself in the same
  repository, and do not start for the single path the plugin checks out.
- `core.hooksPath` / `.git/hooks`: disabled for everything but `commit`;
  commit asks for confirmation (`commit-hooks-confirm`).
- `hook.*` (not in the 2.50.1 list; added by git 2.54, extended in 2.55 /
  2.56): `hook.<name>.command` runs on `hook.<name>.event` without the hooks
  directory, so `core.hooksPath=/dev/null` does not cover it. Restricted in
  repository scope; for the user's own global ones every non-commit command
  carries `-c hook.<event>.enabled=false` (git ≥ 2.55; git has no global off
  switch). Sources: `Documentation/config/hook.adoc`, `git-hook(1)`, `hook.c`
  at v2.54.0 / v2.56.1; behaviour verified with git 2.56.1
  (`repo-safety-real-git` R46–R47).
- `extensions.partialClone` and promisor remotes are deliberately not
  restricted (blobless clones are common); the network block keeps missing
  objects missing, and `commit --quiet` avoids reading them at all.
- `core.unsetenvvars`, `core.restrictinheritedhandles`, `core.hideDotFiles`
  exist only in Git for Windows and affect child processes git starts; with
  the settings above no child process is started (not verified on Windows).

Not config, but found by the same audit:

- Paths. `GIT_LITERAL_PATHSPECS=1` on every command but `commit`: a file named
  `*` or `:(glob)**` is one file. Paths reported by git are checked with
  `isSafeRepoRelativePath` — a forged index can list `../x`, absolute paths
  and `.git/hooks/x` (`repo-safety-real-git` R42).
- Nested repositories. A gitlink entry needs no `.gitmodules`; the nested
  repository's own config is never inspected, so the invariant is that no
  plugin command starts a process inside it (`repo-safety-real-git` R32–R34,
  checked with `GIT_TRACE`).

Real-git assertions per group: `repo-safety-real-git` R2–R5 (restricted keys,
first pins), R7–R15, R46–R47 (hooks), R14 / R35–R38 (network), R32–R34 (submodules,
maintenance), R39–R41 (pathspecs), R43–R44 (output pins), R45 (pager, editor,
alias, trace2, help / tool commands).

When a new git release adds keys, rerun `git help --config`, diff against this
table and extend it; prefer a `-c` pin over a new restricted key.
