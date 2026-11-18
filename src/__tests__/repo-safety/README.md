# Repo Safety (restricted repositories)

Opening a folder whose `.git` was written by someone else (an extracted
archive, a shared drive) must not let it harm the user when the viewer
automatically runs git. Such a repository has two kinds of leverage:

- **Execution** — local config makes git run programs. git has no switch to
  disable `filter.<drv>.clean` (it runs while `git status` re-hashes files).
- **Redirection** — nothing is executed, but git resolves the working tree, the
  git directory or the object store to somewhere outside the workspace, so
  status / diff display outside files (or another private repository) and
  stage / discard / commit write there.

Before any git command the plugin probes the repository in three steps; a
restricted verdict at one step skips the later ones.

1. **Config** — `git config --list --show-scope --includes -z` (reads config
   only, executes nothing).
   - Only `local` / `worktree` scope entries are inspected (including files
     pulled in via `include.path` / `includeIf`); global/system config is the
     user's own.
   - Executable keys (filter clean/smudge/process, diff textconv/command,
     diff.external, merge drivers, gpg programs, askpass, gitproxy,
     upload/receive pack, protocol.*.allow, trailer commands, git-lfs
     extensions/custom transfers, gc.recentObjectsHook, non-boolean
     core.fsmonitor, `diff.submodule` other than short/log) → restricted.
   - The whole `hook.*` section → restricted. Since git 2.54 a hook can be
     defined in config (`hook.<name>.command` + `hook.<name>.event`); git runs
     it on the event without consulting the hooks directory, so the
     `core.hooksPath=/dev/null` override does not stop it (verified with git
     2.56.1: it fires on `add` and on a `status` that refreshes the index).
   - Redirect keys → restricted: `core.worktree` (any value), `core.bare`
     unless false, `extensions.refStorage` unless it is one of the format
     names `files` / `reftable` (git ≥ 2.5x also accepts `files://<dir>`, which
     moves HEAD, refs and reflogs to that directory), and
     `core.attributesFile` / `core.excludesFile` (any value):
     git reads whatever file the repository names, and prints words of a
     malformed attributes file on stderr (`<word> is not a valid attribute
     name: <file>:<line>`), which the plugin shows in a toast when a command
     fails. They are restricted rather than pinned empty with `-c`, because a
     pin would also switch off the user's own global attributes / excludes
     (their normal home; in repository scope the keys are rare).
   - Keys are split the way git splits them (`splitConfigKey`, mirroring
     `parse_config_key`): section = up to the first dot, variable name = after
     the last dot, subsection = everything in between. The subsection may
     contain dots (`[remote "a.uploadpack"] url` is `remote.a.uploadpack.url`,
     the url of that remote), may be empty (`[filter ""] clean` is
     `filter..clean`; `* filter=` selects that driver and git runs it) and may
     hold any character (U+2028, which a regex `.` does not match). The
     restricted rules, the reviewed table and the running git's key list all
     go through this one split; whole-key regexes are not used.
   - **Every other key must be reviewed, or unknown to git** (default-deny).
     The lists above are a blocklist frozen at the git version that was
     audited; each key a later git adds that runs a program (as `hook.*` did)
     would be a new hole. So for each remaining `local` / `worktree` key:
     1. it is in the reviewed table (`src/git/known-config-keys.ts`: the keys
        of `git help --config` that the audit found safe or neutralized, in
        git's own notation — `branch.<name>.remote`, `alias.*`; a middle
        wildcard is the whole subsection — dotted, empty, any character — a
        trailing one is a variable name) → fine;
     2. otherwise the running git is asked what it understands: `git help
        --config` (hardened like every call; prints git's built-in key list,
        reads no repository key, starts no pager / browser / alias / child
        process). Only run when such a key exists.
        - git documents the key → git will interpret a setting nobody
          reviewed → restricted (`unknown-config`), naming the keys and
          saying git can still be used in a terminal.
        - git does not document it → private data of another tool (`gh`'s
          `branch.<n>.gh-merge-base` / `remote.<n>.gh-resolved`, VS Code's
          `branch.<n>.vscode-merge-base`, `gitflow.*`, `lfs.*`,
          `filter.lfs.required`, `svn-remote.*`, `git-town.*`, Git for
          Windows' `core.longpaths`, …): git ignores it → fine.
        - the command fails, times out, is truncated, or its output is not a
          key list (fewer than 300 keys, or `core.bare` / `user.name`
          missing) → new keys cannot be told from private ones → those keys
          are restricted, the message says why, and the verdict is not
          cached.
     Restricted keys take precedence (git is not asked). Global / system /
     command scope is never inspected.
     Limit: only keys git *documents* can be recognised this way
     (`git help --config` is generated from the documentation).
2. **Layout** (defense in depth, independent of the key list) — one
   `git rev-parse --path-format=absolute --is-inside-work-tree --show-prefix
   --absolute-git-dir --git-common-dir --show-toplevel`:
   - git itself must report that the workspace root is the top of the working
     tree (`true` + empty prefix). The comparison is done by git, so it is not
     confused by `/tmp` → `/private/tmp` or case-insensitive file systems.
     Subfolder of a repository, bare repository, redirected working tree →
     restricted.
   - the git directory and the common directory must both lie inside the
     toplevel. A linked worktree or submodule whose main repository lives
     outside the workspace is therefore restricted too: it cannot be told apart
     from a `.git` that points at the victim's other private repository.
   - output that is not exactly five lines (newline in a path, git < 2.31) or
     any other failure → restricted. A folder that is not inside any repository
     is not restricted (nothing to protect; detection reports it as before).
3. **Symbolic links inside the git directory** (`app.fs.listDir` / `lstat`, no
   process) — for the git directory and the common directory: any symbolic
   link among the top-level entries, anywhere under `refs` / `logs` / `info` /
   `reftable`, among the entries of `objects` (fan-out directories included),
   under `objects/info`, or in `objects/pack` → restricted. A non-empty
   `objects/info/alternates` → restricted. A symlinked top-level `hooks` is
   left to the pre-commit hooks check. If file access is unavailable, denied,
   or fails, the repository is restricted.

- Restricted (or probe failure) is fail-closed: every `gitExec` call on that
  repository returns a failed result without spawning git, and the panel shows
  a warning explaining why and how to recover.
- Not flagged on purpose: core.pager/editor (neutralized by `--no-pager` and
  `GIT_EDITOR=:`), network-only keys such as core.sshCommand / credential.helper
  and partial-clone settings (every command, including a commit whose hooks
  were not confirmed, runs with `protocol.allow=never` + `GIT_NO_LAZY_FETCH=1`
  + `GIT_ALLOW_PROTOCOL=`),
  core.hooksPath (hooks are disabled for everything but commit, which asks for
  confirmation), and keys that merely name an outside file that git parses as
  patterns without echoing it (diff.orderFile, mailmap.file) or that the
  plugin never uses
  (commit.template).
- The verdict is cached per repo root keyed by `.git/config` mtime+size
  (`app.fs.stat`, no process). No cache when stat is unavailable or the config
  uses includes; a layout / symlink restriction is never cached. Every panel
  refresh re-probes (`fresh: true`).

The full key-by-key audit (every documented git config key against the
plugin's command set, and how each group is handled) is in
[`doc/git-config-classification.md`](../../../doc/git-config-classification.md).

Reviewed versions: git 2.50.1 (all 954 keys, key by key) and the keys added
up to 2.56.1 (from their documentation). `fixtures/` holds both `git help
--config` outputs. Deliberately unreviewed: `submodule.<name>.gitdir` (git ≥
2.56) — a repository that sets it is restricted when the running git knows the
key — and every `extensions.*` / `feature.*` name outside the reviewed ones
(restricted with any git, since git documents those sections as wildcards).

T1 output parsing. T2–T5 executable key classification (T4b diff.submodule). T18–T20 redirect keys (T18b attributesFile / excludesFile).
T6–T9 config probe and fail-closed. L1–L7 layout probe. S1–S7 symlink scan.
T10–T15b cache. T15c `restrict()` (a verdict set from outside the probe — the forged-index case — holds until the next fresh check). T16–T17 guard wiring into `gitExec`.
K1 key-list notation. K2 reviewed table (common keys known, no restricted key in it). K3 both fixtures fully
classified. K4 no extra git call for reviewed keys. K5 documented-but-unreviewed → restricted. K6 private tool
keys → trusted. K7 `git help --config` unusable → restricted, not cached. K8 only repository scope. K9 restricted
keys win. K10 cache.
K11 keys a newer git adds (plain, with subsection, new variable in an existing section): repository scope →
`unknown-config` naming the key; global / system / command scope → trusted. K12 `extensions.*`: only the nine
reviewed names pass, any other name is restricted with every git and when git cannot be asked. K13
`extensions.refStorage` by value. K14 `feature.*`: only the two reviewed presets. K15 **known limitation, pinned**:
a new variable inside a section the table can only list as a wildcard (`http.<url>.*`, `credential.<url>.*`,
`bundle.*`, `bundle.<id>.*`, `sendemail.<identity>.*`, `sideband.<url>.*`, `alias.*`, `pager.<cmd>`) counts as
reviewed — trusted, git not asked, even if a newer git documents it by name (why this is bounded:
`doc/git-config-classification.md`, "Sections git documents only as a wildcard"). K16 the wildcard entries of the
table are a fixed list; adding one turns it red.

`config-key-classification.spec.ts` (shared helper: `key-overlap.ts`):
C1 `splitConfigKey`. C2 one group per wildcard section (remote, branch, submodule, url, http, credential, filter,
diff, merge, includeIf, pager, alias, guitool / difftool / mergetool, trailer, hook, gpg, protocol, lfs): names
containing dots, empty names, names ending like another variable. C3 the key-list matcher uses the same split.
C4 end to end (empty / odd driver names restricted; look-alike remote / branch names trusted). C5 include keys and
the cache; C5b unsplittable key → restricted. C6 **overlap snapshot**: every documented key of both fixtures and
every table entry, instantiated with ordinary / dotted / empty / look-alike names — the keys that are both
restricted and reviewed must be exactly `REVIEWED_OVERLAP` (`core.bare`, `core.fsmonitor`, `diff.submodule`: the
three value-dependent keys). Restricted rules are evaluated first, so an overlap is always restricted; a new
overlap still turns C6 red so a person looks at it before updating the snapshot. C7 the three overlapping keys by
value. C8 no instantiation of a documented restricted key is reviewed or unrestricted.
