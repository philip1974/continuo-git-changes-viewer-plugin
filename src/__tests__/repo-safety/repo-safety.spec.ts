import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { gitExec } from '../../git/exec';
import { KNOWN_SAFE_CONFIG_KEYS, parseConfigKeyList } from '../../git/known-config-keys';
import {
  installRepoSafetyGuard,
  isKnownSafeConfigKey,
  KNOWN_KEYS_PROBE_ARGS,
  isRedirectConfigEntry,
  isRepoControlledScope,
  isUnsafeConfigEntry,
  LAYOUT_PROBE_ARGS,
  parseScopedConfigList,
  parseScopedConfigListStrict,
  probeRepoSafety,
  PROBE_ARGS,
  RepoSafetyGuard,
} from '../../git/repo-safety';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';

function result(overrides: Partial<PluginShellExecResult> = {}): PluginShellExecResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

const z = (...records: Array<[string, string, string?]>) =>
  records
    .map(([scope, key, value]) => `${scope}\0${value === undefined ? key : `${key}\n${value}`}\0`)
    .join('');

const local = (key: string, value = 'x') => ({ scope: 'local', key, value });

// 布局探测(rev-parse)的正常输出:cwd 就是工作树顶层,git 目录在其内
const layoutOut = (o: { inside?: string; prefix?: string; gitDir?: string; commonDir?: string; top?: string } = {}) =>
  `${o.inside ?? 'true'}\n${o.prefix ?? ''}\n${o.gitDir ?? '/repo/.git'}\n${o.commonDir ?? o.gitDir ?? '/repo/.git'}\n${o.top ?? '/repo'}\n`;

const isConfigProbe = (args: readonly string[]) => args.includes('--show-scope');
const isLayoutProbe = (args: readonly string[]) => args.includes('--is-inside-work-tree');
const isHelpProbe = (args: readonly string[]) => args.slice(-2).join(' ') === 'help --config';

/** `git help --config` 的真实输出(随仓库保存的两份):本机 git 2.50.1 与 Homebrew git 2.56.1。 */
const helpFixture = (version: '2.50.1' | '2.56.1') =>
  readFileSync(join(__dirname, 'fixtures', `git-help-config-${version}.txt`), 'utf8');
const HELP_2_50 = helpFixture('2.50.1');
const HELP_2_56 = helpFixture('2.56.1');
const helpKeys = (stdout: string) => stdout.split('\n').filter((l) => l !== '' && !l.includes(' '));
/** 把文档写法的键(`branch.<name>.remote`、`alias.*`)换成一个具体的键。 */
const instantiate = (key: string) => key.split('.').map((s) => (s === '*' || /^<.*>$/.test(s) ? 'x' : s)).join('.');

/** exec 替身:配置探测返回 config,布局探测返回 layout,`git help --config` 返回 help(null = 宿主没给结果),其余命令返回 other。 */
function gitMock(
  config = '',
  layout: PluginShellExecResult = result({ stdout: layoutOut() }),
  other = result(),
  help: PluginShellExecResult | null = result({ stdout: HELP_2_50 }),
) {
  return vi.fn(async (_cmd: string, args: readonly string[], _opts?: unknown) =>
    isConfigProbe(args) ? result({ stdout: config }) : isLayoutProbe(args) ? layout : isHelpProbe(args) ? (help ?? undefined) : other,
  );
}

const enoent = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
type Entry = { name: string; isFile: boolean; isDirectory: boolean; isSymlink: boolean };
const dir = (name: string): Entry => ({ name, isFile: false, isDirectory: true, isSymlink: false });
const file = (name: string): Entry => ({ name, isFile: true, isDirectory: false, isSymlink: false });
const link = (name: string): Entry => ({ name, isFile: false, isDirectory: false, isSymlink: true });

/** fs 替身:tree 以绝对目录路径为键;未列出的目录读取抛 ENOENT 以外的错误由调用方自行提供。 */
function fsMock(tree: Record<string, Entry[]> = { '/repo/.git': [] }, alternatesSize: number | null = null) {
  const listDir = vi.fn(async (path: string) => {
    const entries = tree[path];
    if (!entries) throw new Error(`ScopeError: path is outside granted scopes: ${path}`);
    return entries;
  });
  const lstat = vi.fn(async (_path: string) => {
    if (alternatesSize === null) throw enoent();
    return { size: alternatesSize, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false };
  });
  return { listDir, lstat };
}

const configCalls = (exec: ReturnType<typeof gitMock>) => exec.mock.calls.filter((c) => isConfigProbe(c[1])).length;

describe('parseScopedConfigList', () => {
  it('T1 parses scope\\0key\\nvalue\\0 records, including valueless keys and multi-line values', () => {
    expect(
      parseScopedConfigList(
        z(['global', 'filter.lfs.clean', 'git-lfs clean -- %f'], ['local', 'core.bare', 'false'], ['local', 'core.fsmonitor']) +
          'local\0alias.x\nline1\nline2\0',
      ),
    ).toEqual([
      { scope: 'global', key: 'filter.lfs.clean', value: 'git-lfs clean -- %f' },
      { scope: 'local', key: 'core.bare', value: 'false' },
      { scope: 'local', key: 'core.fsmonitor', value: null },
      { scope: 'local', key: 'alias.x', value: 'line1\nline2' },
    ]);
  });
});

describe('parseScopedConfigListStrict', () => {
  it('T1b well-formed output parses exactly like parseScopedConfigList; empty output is an empty list', () => {
    const out = z(['global', 'filter.lfs.clean', 'git-lfs clean -- %f'], ['local', 'core.fsmonitor'], ['unknown', 'credential.helper', 'osxkeychain']) + 'local\0alias.x\nline1\nline2\0';
    expect(parseScopedConfigListStrict(out)).toEqual(parseScopedConfigList(out));
    expect(parseScopedConfigListStrict('')).toEqual([]);
  });

  it.each([
    ['no terminating NUL', 'local\0core.bare\nfalse'],
    ['a scope without a record', 'local\0core.bare\nfalse\0local\0'],
    ['an empty scope', '\0core.bare\nfalse\0'],
    ['a scope that is not a lowercase word (output without --show-scope: the key lands in the scope slot)', 'core.bare\nfalse\0user.name\nx\0'],
    ['a scope with a space', 'lo cal\0core.bare\nfalse\0'],
    ['an uppercase scope', 'Local\0core.bare\nfalse\0'],
    ['an empty key', 'local\0\nvalue\0'],
    ['plain text', 'usage: git config [<options>]\n'],
  ])('T1c %s → null (the output cannot be trusted to say which scope a key is in)', (_label, stdout) => {
    expect(parseScopedConfigListStrict(stdout)).toBeNull();
  });
});

describe('isUnsafeConfigEntry', () => {
  it.each([
    'filter.x.clean',
    'filter.x.smudge',
    'filter.x.process',
    'filter.a.b.clean',
    'Filter.X.Clean',
    'diff.x.textconv',
    'diff.x.command',
    'diff.external',
    'merge.x.driver',
    'gpg.program',
    'gpg.ssh.program',
    'gpg.x509.program',
    'gpg.ssh.defaultkeycommand',
    'core.askpass',
    'core.gitproxy',
    'core.alternaterefscommand',
    'uploadpack.packobjectshook',
    'remote.origin.uploadpack',
    'remote.origin.receivepack',
    'protocol.ext.allow',
    'trailer.sign.command',
    'trailer.sign.cmd',
    'lfs.extension.foo.clean',
    'lfs.customtransfer.foo.path',
    'gc.recentObjectsHook',
    // 配置式 hooks(git >= 2.54):不经 hooks 目录,core.hooksPath=/dev/null 管不到;整个 hook.* 段受限
    'hook.x.command',
    'hook.x.event',
    'hook.x.enabled',
    'hook.x.parallel',
    'hook.pre-commit.enabled',
    'hook.post-index-change.jobs',
    'hook.jobs',
    'Hook.My.Linter.Command',
  ])('T2 flags executable key %s in local scope', (key) => {
    expect(isUnsafeConfigEntry(local(key))).toBe(true);
    expect(isUnsafeConfigEntry({ scope: 'worktree', key, value: 'x' })).toBe(true);
  });

  it('T3 trusts exactly the global / system / command scopes (user-owned config)', () => {
    for (const scope of ['global', 'system', 'command']) {
      expect(isRepoControlledScope(scope)).toBe(false);
      expect(isUnsafeConfigEntry({ scope, key: 'filter.lfs.clean', value: 'git-lfs clean' })).toBe(false);
      expect(isRedirectConfigEntry({ scope, key: 'core.worktree', value: '/x' })).toBe(false);
    }
  });

  // 只信任已知的三个 scope;其余任何名字——local / worktree、git 现有的 submodule / unknown、将来新增的、
  // 大小写不同的、空的——都按仓库可控处理(此前是"不可信名单":名单之外一律放行)。
  it.each(['local', 'worktree', 'submodule', 'unknown', 'remote', 'repository', 'Global', 'GLOBAL', 'global ', ' system', 'command\n', ''])(
    'T3b scope %j is not on the trusted list → its entries are judged like repository config',
    (scope) => {
      expect(isRepoControlledScope(scope)).toBe(true);
      expect(isUnsafeConfigEntry({ scope, key: 'filter.lfs.clean', value: 'git-lfs clean' })).toBe(true);
      expect(isUnsafeConfigEntry({ scope, key: 'core.fsmonitor', value: '/bin/evil' })).toBe(true);
      expect(isRedirectConfigEntry({ scope, key: 'core.worktree', value: '/x' })).toBe(true);
      expect(isUnsafeConfigEntry({ scope, key: 'user.name', value: 'x' })).toBe(false);
    },
  );

  it('T4 core.fsmonitor: boolean (built-in daemon) is fine, a program path is flagged', () => {
    for (const value of ['true', 'false', 'TRUE', '0', '1', 'yes', 'off', '']) {
      expect(isUnsafeConfigEntry(local('core.fsmonitor', value))).toBe(false);
    }
    expect(isUnsafeConfigEntry({ scope: 'local', key: 'core.fsmonitor', value: null })).toBe(false);
    expect(isUnsafeConfigEntry(local('core.fsmonitor', '/tmp/evil'))).toBe(true);
  });

  it('T4b diff.submodule: short / log stay trusted, diff (spawns git inside the nested repository) or anything else is flagged', () => {
    for (const value of ['short', 'log', 'SHORT', ' log ']) {
      expect(isUnsafeConfigEntry(local('diff.submodule', value))).toBe(false);
    }
    for (const value of ['diff', 'DIFF', 'bogus', '']) {
      expect(isUnsafeConfigEntry(local('Diff.Submodule', value))).toBe(true);
    }
    expect(isUnsafeConfigEntry({ scope: 'local', key: 'diff.submodule', value: null })).toBe(true);
    expect(isUnsafeConfigEntry({ scope: 'global', key: 'diff.submodule', value: 'diff' })).toBe(false);
  });

  it.each([
    'core.hookspath',
    'core.sshcommand',
    'core.pager',
    'core.editor',
    'credential.helper',
    'filter.lfs.required',
    'diff.x.binary',
    'remote.origin.url',
    'user.name',
    'core.symlinks',
    'core.sparsecheckout',
    'commit.template',
    'gc.auto',
    'extensions.worktreeconfig',
  ])('T5 does not flag neutralized / non-executable key %s (documented trade-off)', (key) => {
    expect(isUnsafeConfigEntry(local(key))).toBe(false);
  });
});

describe('isRedirectConfigEntry', () => {
  it('T18 core.worktree in local / worktree scope is flagged whatever its value', () => {
    for (const scope of ['local', 'worktree']) {
      for (const value of ['/etc', '..', '.', '']) {
        expect(isRedirectConfigEntry({ scope, key: 'core.worktree', value })).toBe(true);
        expect(isUnsafeConfigEntry({ scope, key: 'Core.WorkTree', value })).toBe(true);
      }
    }
    expect(isUnsafeConfigEntry({ scope: 'global', key: 'core.worktree', value: '/etc' })).toBe(false);
  });

  it('T19 core.bare: false (git init default) is fine; true / valueless / anything else is flagged', () => {
    for (const value of ['false', 'FALSE', 'no', 'off', '0', '']) {
      expect(isUnsafeConfigEntry(local('core.bare', value))).toBe(false);
    }
    for (const value of ['true', 'yes', 'on', '1', 'maybe']) {
      expect(isUnsafeConfigEntry(local('core.bare', value))).toBe(true);
    }
    expect(isUnsafeConfigEntry({ scope: 'local', key: 'core.bare', value: null })).toBe(true);
    expect(isUnsafeConfigEntry({ scope: 'system', key: 'core.bare', value: 'true' })).toBe(false);
  });

  it('T18b core.attributesFile / core.excludesFile in local / worktree scope are flagged whatever their value (git reads the named file, and echoes words of a malformed attributes file on stderr); global ones are the user\'s own', () => {
    for (const key of ['core.attributesfile', 'core.excludesfile', 'Core.AttributesFile', 'CORE.EXCLUDESFILE']) {
      for (const scope of ['local', 'worktree']) {
        for (const value of ['/Users/me/.netrc', '~/.ssh/id_rsa', '.gitattributes-extra', '']) {
          expect(isRedirectConfigEntry({ scope, key, value })).toBe(true);
          expect(isUnsafeConfigEntry({ scope, key, value })).toBe(true);
        }
        expect(isUnsafeConfigEntry({ scope, key, value: null })).toBe(true);
      }
      for (const scope of ['global', 'system', 'command']) {
        expect(isUnsafeConfigEntry({ scope, key, value: '~/.config/git/attributes' })).toBe(false);
      }
    }
  });

  it('T20 executable keys are not redirect keys', () => {
    expect(isRedirectConfigEntry(local('filter.x.clean'))).toBe(false);
  });
});

describe('probeRepoSafety', () => {
  function app(config: string, layout?: PluginShellExecResult, fs: unknown = fsMock()) {
    const exec = gitMock(config, layout);
    return { app: { shell: { exec }, fs } as unknown as CoPluginApp, exec };
  }

  it('T6 runs the read-only config probe with includes and scopes, then the layout probe', async () => {
    const { app: a, exec } = app('');
    await probeRepoSafety(a, '/repo');
    expect(PROBE_ARGS).toEqual(['config', '--list', '--show-scope', '--includes', '-z']);
    expect(exec.mock.calls[0]![1].slice(-5)).toEqual([...PROBE_ARGS]);
    expect(exec.mock.calls[0]![2]).toMatchObject({ cwd: '/repo' });
    expect(LAYOUT_PROBE_ARGS).toEqual([
      'rev-parse',
      '--path-format=absolute',
      '--is-inside-work-tree',
      '--show-prefix',
      '--absolute-git-dir',
      '--git-common-dir',
      '--show-toplevel',
    ]);
    expect(exec.mock.calls[1]![1].slice(-LAYOUT_PROBE_ARGS.length)).toEqual([...LAYOUT_PROBE_ARGS]);
    expect(exec.mock.calls[1]![2]).toMatchObject({ cwd: '/repo', env: { LC_ALL: 'C' } });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('T7 trusted when no local unsafe key exists and the layout is self-contained', async () => {
    const { app: a } = app(z(['global', 'filter.lfs.clean', 'git-lfs clean'], ['global', 'core.worktree', '/x'], ['local', 'core.bare', 'false']));
    await expect(probeRepoSafety(a, '/repo')).resolves.toEqual({ kind: 'trusted', cacheable: true });
  });

  // Apple Git(Xcode 自带)把 `<Xcode>/usr/share/git-core/gitconfig` 的两个键报告为 scope `unknown`(实测 2.50.1)
  const APPLE_DEFAULTS: Array<[string, string, string]> = [['unknown', 'credential.helper', 'osxkeychain'], ['unknown', 'init.defaultbranch', 'main']];

  it('T7b an ordinary repository on Apple Git: its bundled defaults arrive in scope `unknown`; they are reviewed keys → trusted, cacheable, git is not asked about them', async () => {
    const { app: a, exec } = app(z(...APPLE_DEFAULTS, ['global', 'user.name', 'me'], ['local', 'core.bare', 'false'], ['local', 'remote.origin.url', 'x']));
    await expect(probeRepoSafety(a, '/repo')).resolves.toEqual({ kind: 'trusted', cacheable: true });
    expect(exec.mock.calls.filter((c) => isHelpProbe(c[1]))).toEqual([]);
  });

  it.each(['unknown', 'submodule', 'remote'])(
    'T7c an executable / redirect / unreviewed key in scope %s (not global, system or command) restricts the repository',
    async (scope) => {
      const exe = await probeRepoSafety(app(z([scope, 'filter.x.clean', 'evil'])).app, '/repo');
      expect(exe).toMatchObject({ kind: 'restricted', reason: 'unsafe-config', keys: ['filter.x.clean'] });
      const redirect = await probeRepoSafety(app(z([scope, 'core.worktree', '/etc'])).app, '/repo');
      expect(redirect).toMatchObject({ kind: 'restricted', reason: 'unsafe-config', keys: ['core.worktree'] });
      // HELP_2_56 文档化、但审计表里没有的键(K5 同款)
      const exec = gitMock(z([scope, 'submodule.x.gitdir', 'y']), undefined, undefined, result({ stdout: HELP_2_56 }));
      const unreviewed = await probeRepoSafety({ shell: { exec }, fs: fsMock() } as unknown as CoPluginApp, '/repo');
      expect(unreviewed).toMatchObject({ kind: 'restricted', reason: 'unknown-config', keys: ['submodule.x.gitdir'] });
    },
  );

  it.each([
    ['no terminating NUL', 'local\0core.bare\nfalse'],
    ['a dangling scope', 'local\0core.bare\nfalse\0local\0'],
    ['records without scopes (a git that ignored --show-scope)', 'core.bare\nfalse\0filter.x.clean\nevil\0'],
    ['a scope that is not a lowercase word', 'Local\0core.bare\nfalse\0'],
    ['an empty scope in front of a harmless key', '\0user.name\nme\0'],
    ['an empty scope in front of an executable key', '\0filter.x.clean\nevil\0'],
  ])('T9b fails closed when the config probe output is malformed (%s): restricted, probe-failed, not cached, no further probe', async (_label, stdout) => {
    const { app: a, exec } = app(stdout);
    const r = await probeRepoSafety(a, '/repo');
    expect(r).toMatchObject({ kind: 'restricted', reason: 'probe-failed', cacheable: false });
    expect(r.kind === 'restricted' && r.message).toContain('the git config safety check failed (unexpected output format)');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('T8 restricted with the offending keys listed in the message; the layout probe is not run', async () => {
    const { app: a, exec } = app(z(['local', 'filter.x.clean', 'evil'], ['local', 'diff.external', 'evil2'], ['local', 'filter.x.clean', 'again']));
    const r = await probeRepoSafety(a, '/repo');
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unsafe-config', keys: ['filter.x.clean', 'diff.external'] });
    expect(r.kind === 'restricted' && r.message).toContain('filter.x.clean, diff.external');
    expect(r.kind === 'restricted' && r.message).toContain('run external programs');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('T8b redirect keys get their own wording; mixed with executable keys the executable wording wins', async () => {
    const only = await probeRepoSafety(app(z(['local', 'core.worktree', '/etc'])).app, '/repo');
    expect(only).toMatchObject({ kind: 'restricted', reason: 'unsafe-config', keys: ['core.worktree'] });
    expect(only.kind === 'restricted' && only.message).toContain('point git away from this folder (core.worktree)');

    const mixed = await probeRepoSafety(app(z(['local', 'core.worktree', '/etc'], ['local', 'diff.external', 'x'])).app, '/repo');
    expect(mixed.kind === 'restricted' && mixed.message).toContain('run external programs (core.worktree, diff.external)');
  });

  it.each([
    ['non-zero exit', result({ exitCode: 129, stderr: 'error: unknown option `show-scope`' })],
    ['truncated', result({ truncated: true })],
    ['timed out', result({ timedOut: true, exitCode: null })],
    ['no result', undefined],
  ])('T9 fails closed when the config probe fails (%s)', async (_label, r) => {
    const exec = vi.fn().mockResolvedValue(r);
    const a = { shell: { exec }, fs: fsMock() } as unknown as CoPluginApp;
    await expect(probeRepoSafety(a, '/repo')).resolves.toMatchObject({ kind: 'restricted', reason: 'probe-failed', cacheable: false });
  });
});

describe('config keys the viewer has not reviewed (default-deny for keys git understands)', () => {
  const helpCalls = (exec: ReturnType<typeof gitMock>) => exec.mock.calls.filter((c) => isHelpProbe(c[1]));
  function probeWith(config: string, help?: PluginShellExecResult | null) {
    const exec = gitMock(config, undefined, undefined, help);
    return { exec, verdict: probeRepoSafety({ shell: { exec }, fs: fsMock() } as unknown as CoPluginApp, '/repo') };
  }

  it('K1 parseConfigKeyList reads `git help --config` notation: <placeholder> / * segments are wildcards (a middle one may contain dots, the last one may not), names are case-insensitive, non-key lines are ignored', () => {
    const m = parseConfigKeyList("\nbranch.<name>.remote\nalias.*\nhttp.<url>.*\ncore.bare\nmaintenance.commit-graph.auto\n\n'git help config' for more information\n");
    expect(m.size).toBe(5);
    for (const key of ['branch.main.remote', 'branch.feat/a.b.remote', 'BRANCH.Main.Remote', 'alias.co', 'http.https://x.y/z.sslverify', 'core.bare', 'Core.Bare', 'maintenance.commit-graph.auto']) {
      expect({ key, known: m.matches(key) }).toEqual({ key, known: true });
    }
    for (const key of ['branch.main.gh-merge-base', 'branch.remote', 'alias.co.command', 'http.sslverify', 'core.barely', 'xcore.bare', 'core.bare.x', 'git', 'for more information']) {
      expect({ key, known: m.matches(key) }).toEqual({ key, known: false });
    }
  });

  it('K2 the reviewed table: common repository keys are known; no entry is a restricted key (those must stay out of it)', () => {
    for (const key of ['core.bare', 'core.repositoryformatversion', 'core.filemode', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode',
      'core.hookspath', 'core.sshcommand', 'core.fsmonitor', 'diff.submodule', 'user.name', 'user.email', 'remote.origin.url', 'remote.origin.fetch',
      'remote.origin.promisor', 'branch.main.remote', 'branch.feat/x.y.merge', 'branch.main.description', 'submodule.libs/a.b.url', 'submodule.x.active',
      'include.path', 'includeif.gitdir:~/work/.path', 'extensions.worktreeconfig', 'credential.helper', 'alias.co', 'pull.rebase', 'commit.gpgsign',
      'status.comparebranches', 'core.lockfilepid']) {
      expect({ key, known: isKnownSafeConfigKey(key) }).toEqual({ key, known: true });
    }
    const safeValue: Record<string, string> = { 'core.bare': 'false', 'core.fsmonitor': 'false', 'diff.submodule': 'short', 'extensions.refstorage': 'files' };
    const entries = helpKeys(KNOWN_SAFE_CONFIG_KEYS);
    expect(entries.length).toBeGreaterThan(900);
    const restrictedInTable = entries.filter((k) => {
      const key = instantiate(k);
      return isUnsafeConfigEntry(local(key, safeValue[key.toLowerCase()] ?? 'x'));
    });
    expect(restrictedInTable).toEqual([]);
    for (const key of ['filter.x.clean', 'diff.x.textconv', 'diff.external', 'hook.x.command', 'hook.jobs', 'core.worktree', 'core.attributesfile',
      'core.excludesfile', 'remote.origin.uploadpack', 'protocol.file.allow', 'gpg.program', 'submodule.x.gitdir']) {
      expect({ key, known: isKnownSafeConfigKey(key) }).toEqual({ key, known: false });
    }
  });

  it('K3 every key git documents is either restricted or reviewed — except the two wildcard headings narrowed to reviewed names (extensions.*, feature.*: see K12 / K14) and, in git 2.56.1, submodule.<name>.gitdir (left unreviewed on purpose)', () => {
    const unreviewed = (help: string) =>
      helpKeys(help).filter((k) => {
        const key = instantiate(k);
        // 文档里唯一不是配置键的一行(includeIf 的条件写法)
        if (k.startsWith('hasconfig:')) return false;
        return !isKnownSafeConfigKey(key) && !isUnsafeConfigEntry(local(key, 'x')) && !isUnsafeConfigEntry(local(key, 'false'));
      });
    expect(helpKeys(HELP_2_50)).toHaveLength(954);
    expect(unreviewed(HELP_2_50)).toEqual(['extensions.*', 'feature.*']);
    expect(helpKeys(HELP_2_56)).toHaveLength(1011);
    expect(unreviewed(HELP_2_56)).toEqual(['extensions.*', 'feature.*', 'submodule.<name>.gitdir']);
  });

  it('K4 only reviewed keys in the repository config → git is not asked which keys it understands', async () => {
    const { exec, verdict } = probeWith(z(['local', 'core.bare', 'false'], ['local', 'remote.origin.url', 'x'], ['local', 'branch.main.merge', 'refs/heads/main'], ['local', 'user.name', 'n']));
    await expect(verdict).resolves.toEqual({ kind: 'trusted', cacheable: true });
    expect(helpCalls(exec)).toHaveLength(0);
  });

  it('K5 a key the running git documents but the viewer never reviewed (a newer git added it) → restricted (unknown-config); asked through the hardened `git help --config` in the repo; the layout probe is not run', async () => {
    const newerGit = `${HELP_2_50}hook.<friendly-name>.command\nfoo.bar\nsubmodule.<name>.gitdir\nnewsection.<name>.*\n`;
    const { exec, verdict } = probeWith(
      z(['local', 'core.bare', 'false'], ['local', 'foo.bar', '1'], ['worktree', 'submodule.lib.gitdir', '/elsewhere'], ['local', 'newsection.a.b.exec', 'x'], ['local', 'foo.bar', '2'], ['local', 'gitflow.branch.master', 'main']),
      result({ stdout: newerGit }),
    );
    const r = await verdict;
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unknown-config', keys: ['foo.bar', 'submodule.lib.gitdir', 'newsection.a.b.exec'] });
    const message = r.kind === 'restricted' ? r.message : '';
    expect(message).toContain('Git commands are disabled for this repository: its local git config contains settings this viewer does not recognize (foo.bar, submodule.lib.gitdir, newsection.a.b.exec)');
    expect(message).toContain('You can still use git in a terminal');
    expect(message).toContain('click Refresh');
    expect(KNOWN_KEYS_PROBE_ARGS).toEqual(['help', '--config']);
    const [call] = helpCalls(exec);
    expect(helpCalls(exec)).toHaveLength(1);
    expect(call![1]).toEqual(expect.arrayContaining(['--no-pager', 'core.hooksPath=/dev/null', 'protocol.allow=never']));
    expect(call![2]).toMatchObject({ cwd: '/repo', env: { GIT_OPTIONAL_LOCKS: '0' } });
    expect(exec.mock.calls.some((c) => isLayoutProbe(c[1]))).toBe(false);
  });

  it('K6 keys git itself does not document are private data of other tools (gh, VS Code, git-flow, git-lfs, git-svn, ...) → trusted, with git 2.50.1 and 2.56.1 alike', async () => {
    const privateKeys = [
      'branch.main.gh-merge-base', 'remote.origin.gh-resolved', 'branch.feat.vscode-merge-base', 'branch.feat.github-pr-owner-number',
      'gitflow.branch.master', 'gitflow.prefix.feature', 'lfs.repositoryformatversion', 'lfs.https://example.com/x.git/info/lfs.access',
      'filter.lfs.required', 'remote.origin.lfsurl', 'svn-remote.svn.url', 'svn.authorsfile', 'git-town.main-branch', 'git-town-branch.feat.parent',
      'sourcetree.something', 'cola.spellcheck', 'gitreview.username', 'gitbutler.aiopenaikey', 'codespaces.x', 'jj.x', 'absorb.maxstack',
      'delta.navigate', 'bash.showdirtystate', 'oh-my-zsh.hide-status', 'ghq.root', 'core.longpaths', 'core.fscache',
    ];
    const config = z(['local', 'core.bare', 'false'], ...privateKeys.map((k): [string, string, string] => ['local', k, 'v']));
    for (const help of [HELP_2_50, HELP_2_56]) {
      const { exec, verdict } = probeWith(config, result({ stdout: help }));
      await expect(verdict).resolves.toEqual({ kind: 'trusted', cacheable: true });
      expect(helpCalls(exec)).toHaveLength(1);
    }
  });

  it.each([
    ['non-zero exit', result({ exitCode: 129, stderr: 'usage: git help' })],
    ['truncated', result({ stdout: HELP_2_50, truncated: true })],
    ['timed out', result({ stdout: HELP_2_50, timedOut: true })],
    ['empty output', result()],
    ['output that is not a key list', result({ stdout: 'usage: git [-v | --version] [-h | --help]\n   or: git help\n' })],
    ['a short list (not the full key table)', result({ stdout: 'core.bare\nuser.name\n' })],
    ['no result', null],
  ])('K7 git cannot say which keys it understands (%s) → any unreviewed key is restricted, fail-closed, never cached', async (_label, help) => {
    const { verdict } = probeWith(z(['local', 'branch.main.gh-merge-base', 'abc']), help);
    const r = await verdict;
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unknown-config', keys: ['branch.main.gh-merge-base'], cacheable: false });
    const message = r.kind === 'restricted' ? r.message : '';
    expect(message).toContain('does not recognize (branch.main.gh-merge-base)');
    expect(message).toContain('could not ask git which settings it understands');
    expect(message).toContain('You can still use git in a terminal');
  });

  it('K8 unreviewed keys in global / system / command scope are the user\'s own → ignored, git is not asked', async () => {
    const { exec, verdict } = probeWith(z(['global', 'foo.bar', '1'], ['system', 'hook.x.command', 'x'], ['command', 'hook.pre-commit.enabled', 'false'], ['global', 'submodule.x.gitdir', '/y']), result({ stdout: `${HELP_2_56}foo.bar\n` }));
    await expect(verdict).resolves.toMatchObject({ kind: 'trusted' });
    expect(helpCalls(exec)).toHaveLength(0);
  });

  it('K9 restricted keys win over unreviewed ones: the verdict names the restricted keys and git is not asked', async () => {
    const { exec, verdict } = probeWith(z(['local', 'foo.bar', '1'], ['local', 'hook.x.command', 'evil']), result({ stdout: `${HELP_2_56}foo.bar\n` }));
    await expect(verdict).resolves.toMatchObject({ kind: 'restricted', reason: 'unsafe-config', keys: ['hook.x.command'] });
    expect(helpCalls(exec)).toHaveLength(0);
  });

  it('K10 an unreviewed-key verdict follows the config cache rules: cached while .git/config is unchanged, re-probed after it changes', async () => {
    let config = z(['local', 'foo.bar', '1']);
    let mtimeMs = 1;
    const exec = vi.fn(async (_cmd: string, args: readonly string[]) =>
      isConfigProbe(args) ? result({ stdout: config }) : isLayoutProbe(args) ? result({ stdout: layoutOut() }) : isHelpProbe(args) ? result({ stdout: `${HELP_2_50}foo.bar\n` }) : result(),
    );
    const stat = vi.fn(async (p: string) => ({ size: 10, mtimeMs, isFile: !p.endsWith('.git'), isDirectory: p.endsWith('.git'), isSymlink: false }));
    const guard = new RepoSafetyGuard({ shell: { exec }, fs: { ...fsMock(), stat } } as unknown as CoPluginApp);
    expect(await guard.check('/repo')).toMatchObject({ kind: 'restricted', reason: 'unknown-config' });
    expect(await guard.check('/repo')).toMatchObject({ kind: 'restricted', reason: 'unknown-config' });
    expect(exec.mock.calls.filter((c) => isConfigProbe(c[1]))).toHaveLength(1);
    config = z(['local', 'core.bare', 'false']);
    mtimeMs = 2;
    expect(await guard.check('/repo')).toEqual({ kind: 'trusted' });
  });
});

describe('unknown keys end to end: what a newer git adds, and the sections git documents only as wildcards', () => {
  const helpCalls = (exec: ReturnType<typeof gitMock>) => exec.mock.calls.filter((c) => isHelpProbe(c[1]));
  function probeWith(config: string, help: PluginShellExecResult | null = result({ stdout: HELP_2_56 })) {
    const exec = gitMock(config, undefined, undefined, help);
    return { exec, verdict: probeRepoSafety({ shell: { exec }, fs: fsMock() } as unknown as CoPluginApp, '/repo') };
  }
  // 模拟比已审计列表更新的 git:文档里多出几个键(普通键、带 subsection 的键、已有段里的新变量)
  const NEWER_GIT = `${HELP_2_56}core.newExecHelper\nnewsection.run\nremote.<name>.newHelper\nfuture.<name>.cmd\n`;
  const NEW_KEYS = ['core.newexechelper', 'newsection.run', 'remote.origin.newhelper', 'future.a.b.cmd'];

  it.each(NEW_KEYS)('K11 %s, documented by the running git but never reviewed: in repository scope (local / worktree) → restricted, unknown-config, the message names the key; only in global / system / command scope → trusted and git is not even asked', async (key) => {
    for (const scope of ['local', 'worktree']) {
      const r = await probeWith(z(['local', 'core.bare', 'false'], [scope, key, 'v']), result({ stdout: NEWER_GIT })).verdict;
      expect(r).toMatchObject({ kind: 'restricted', reason: 'unknown-config', keys: [key] });
      expect(r.kind === 'restricted' && r.message).toContain(`does not recognize (${key})`);
      expect(r.kind === 'restricted' && r.message).toContain('Your git understands them, but they are newer than the settings this viewer has reviewed');
    }
    for (const scope of ['global', 'system', 'command']) {
      const { exec, verdict } = probeWith(z(['local', 'core.bare', 'false'], [scope, key, 'v']), result({ stdout: NEWER_GIT }));
      await expect(verdict).resolves.toMatchObject({ kind: 'trusted' });
      expect(helpCalls(exec)).toHaveLength(0);
    }
    // 同一个键,运行时的 git 不认识(旧版本)→ 对它是惰性数据
    await expect(probeWith(z([`local`, key, 'v']), result({ stdout: HELP_2_50 })).verdict).resolves.toMatchObject({ kind: 'trusted' });
  });

  // git 的 extensions 机制本意是"不认识的扩展必须拒绝操作";文档只写 `extensions.*`,问不出 git 认识哪些名字,
  // 所以表里按名字逐个收录,其余名字一律按"git 认识、但没审计"处理。
  const REVIEWED_EXTENSIONS = ['noop', 'noop-v1', 'objectformat', 'compatobjectformat', 'partialclone', 'preciousobjects', 'refstorage', 'relativeworktrees', 'worktreeconfig'];

  it('K12 extensions: only the reviewed extension names pass; any other name in repository scope → restricted (unknown-config) with every git version, and when git cannot be asked', async () => {
    const safeValue: Record<string, string> = { objectformat: 'sha256', compatobjectformat: 'sha1', partialclone: 'origin', refstorage: 'reftable' };
    const reviewed = z(...REVIEWED_EXTENSIONS.map((n): [string, string, string] => ['local', `extensions.${n}`, safeValue[n] ?? 'true']));
    const ok = probeWith(reviewed);
    await expect(ok.verdict).resolves.toEqual({ kind: 'trusted', cacheable: true });
    expect(helpCalls(ok.exec)).toHaveLength(0);

    for (const key of ['extensions.futurething', 'extensions.submodulepathconfig', 'extensions.x']) {
      for (const help of [HELP_2_50, HELP_2_56, NEWER_GIT]) {
        const r = await probeWith(z(['local', 'core.repositoryformatversion', '1'], ['local', key, 'true']), result({ stdout: help })).verdict;
        expect({ key, r }).toMatchObject({ key, r: { kind: 'restricted', reason: 'unknown-config', keys: [key] } });
      }
      expect(await probeWith(z(['worktree', key, 'true']), result({ exitCode: 129 })).verdict).toMatchObject({ kind: 'restricted', reason: 'unknown-config', keys: [key] });
      await expect(probeWith(z(['global', key, 'true'])).verdict).resolves.toMatchObject({ kind: 'trusted' });
    }
    // 带 subsection 的写法不是扩展(git 按 `extensions.<名字>` 整串比较),也不在文档的 `extensions.*` 里
    await expect(probeWith(z(['local', 'extensions.a.b', 'true'])).verdict).resolves.toMatchObject({ kind: 'trusted' });
  });

  it('K13 extensions.refStorage: `files` / `reftable` are formats; anything else (git >= 2.5x accepts `files://<dir>` and keeps HEAD, refs and reflogs in that directory) points git outside the folder → restricted as a redirect key', async () => {
    for (const value of ['files', 'reftable', 'FILES', ' reftable ']) {
      expect(isUnsafeConfigEntry(local('extensions.refstorage', value))).toBe(false);
    }
    for (const value of ['files:///elsewhere', 'reftable:///elsewhere/.git', 'files://', 'file', 'bogus', '']) {
      expect({ value, redirect: isRedirectConfigEntry(local('extensions.refStorage', value)) }).toEqual({ value, redirect: true });
      expect(isUnsafeConfigEntry({ scope: 'worktree', key: 'extensions.refstorage', value })).toBe(true);
    }
    expect(isRedirectConfigEntry({ scope: 'local', key: 'extensions.refstorage', value: null })).toBe(true);
    expect(isRedirectConfigEntry({ scope: 'global', key: 'extensions.refstorage', value: 'files:///elsewhere' })).toBe(false);

    const r = await probeWith(z(['local', 'extensions.refstorage', 'files:///victim/.git'])).verdict;
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unsafe-config', keys: ['extensions.refstorage'] });
    expect(r.kind === 'restricted' && r.message).toContain('settings that point git away from this folder (extensions.refstorage)');
  });

  it('K14 feature: the two reviewed presets pass; another feature.* name (a preset that may switch on settings nobody reviewed) → restricted', async () => {
    const ok = probeWith(z(['local', 'feature.manyfiles', 'true'], ['local', 'feature.experimental', 'true']));
    await expect(ok.verdict).resolves.toMatchObject({ kind: 'trusted' });
    expect(helpCalls(ok.exec)).toHaveLength(0);
    for (const help of [HELP_2_50, HELP_2_56]) {
      await expect(probeWith(z(['local', 'feature.newpreset', 'true']), result({ stdout: help })).verdict).resolves.toMatchObject({
        kind: 'restricted', reason: 'unknown-config', keys: ['feature.newpreset'],
      });
    }
  });

  // 已知局限(钉住现状):下面这些段在 git 文档里本身就是通配(`http.<url>.*` 等),表里也只能按通配收录;
  // 新版本 git 在这些段里加的变量会被当成"已审计"。它们都属于只在联网时生效的一类(插件的每次调用都断网)
  // 或只是名字(alias / pager,插件不调用别名、--no-pager)。见 README "Known limitation"。
  const WILDCARD_SECTION_KEYS = [
    'bundle.newvariable', 'bundle.x.newvariable', 'http.https://h.example/.newvariable', 'credential.https://h.example.newvariable',
    'sendemail.work.newvariable', 'sideband.https://h.example/.newvariable', 'alias.newalias', 'alias.x.command', 'pager.newcommand',
  ];

  it.each(WILDCARD_SECTION_KEYS)('K15 known limitation: %s — a new variable inside a section the reviewed table can only list as a wildcard counts as reviewed (trusted, git not asked), even when a newer git documents it by name', async (key) => {
    const documentedByName = `${NEWER_GIT}${key}\n`;
    const { exec, verdict } = probeWith(z(['local', 'core.bare', 'false'], ['local', key, 'v']), result({ stdout: documentedByName }));
    await expect(verdict).resolves.toMatchObject({ kind: 'trusted' });
    expect(helpCalls(exec)).toHaveLength(0);
    expect(isKnownSafeConfigKey(key)).toBe(true);
  });

  it('K16 the wildcard entries of the reviewed table are a fixed, reviewed list: adding one (which widens what counts as reviewed) turns this red', () => {
    const wildcardTail = helpKeys(KNOWN_SAFE_CONFIG_KEYS).filter((k) => /\.(\*|<[^<>]*>)$/.test(k)).sort();
    expect(wildcardTail).toEqual([
      'alias.*', 'bundle.*', 'bundle.<id>.*', 'credential.<url>.*', 'fetch.fsck.<msg-id>', 'http.<url>.*', 'notes.rewrite.<command>',
      'pager.<cmd>', 'pretty.<name>', 'remotes.<group>', 'sendemail.<identity>.*', 'sideband.<url>.*',
    ]);
  });
});

describe('probeRepoSafety layout (git must use the workspace root as its working tree, git dir inside it)', () => {
  const probe = (layout: PluginShellExecResult, fs: unknown = fsMock()) =>
    probeRepoSafety({ shell: { exec: gitMock('', layout) }, fs } as unknown as CoPluginApp, '/repo');

  it.each([
    ['cwd is outside the working tree (core.worktree elsewhere)', layoutOut({ inside: 'false', top: '/etc' })],
    ['cwd is a subfolder of the working tree', layoutOut({ prefix: 'sub/', top: '/' })],
    ['empty toplevel', layoutOut({ top: '' })],
  ])('L1 %s → restricted (unsafe-layout, working tree)', async (_label, stdout) => {
    const r = await probe(result({ stdout }));
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unsafe-layout', cacheable: false });
    expect(r.kind === 'restricted' && r.message).toContain('working tree');
  });

  it('L2 bare repository: --show-toplevel is fatal after "false" was printed → restricted (working tree)', async () => {
    const r = await probe(result({ exitCode: 128, stdout: 'false\n\n/repo\n/repo\n', stderr: 'fatal: this operation must be run in a work tree' }));
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unsafe-layout' });
  });

  it.each([
    ['git dir outside', layoutOut({ gitDir: '/victim/private/.git' })],
    ['common dir outside (linked worktree / commondir file)', layoutOut({ gitDir: '/repo/.git', commonDir: '/victim/private/.git' })],
    ['git dir outside while the common dir is inside', layoutOut({ gitDir: '/victim/private/.git/worktrees/w', commonDir: '/repo/.git' })],
    ['git dir in a sibling whose name merely starts with the root', layoutOut({ gitDir: '/repo-evil/.git' })],
    ['git dir equal to the toplevel', layoutOut({ gitDir: '/repo' })],
  ])('L3 %s → restricted (unsafe-layout, outside)', async (_label, stdout) => {
    const r = await probe(result({ stdout }));
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unsafe-layout', cacheable: false });
    expect(r.kind === 'restricted' && r.message).toContain('its git directory is outside this folder (');
  });

  it.each([
    ['a path containing a newline', layoutOut({ gitDir: '/repo/a\nb/.git' })],
    ['git < 2.31 echoing --path-format back', `--path-format=absolute\n${layoutOut()}`],
    ['missing lines', 'true\n\n/repo/.git\n'],
    ['no trailing newline', layoutOut().slice(0, -1)],
    ['empty output', ''],
  ])('L4 output that is not exactly five lines (%s) → fails closed', async (_label, stdout) => {
    await expect(probe(result({ stdout }))).resolves.toMatchObject({ kind: 'restricted', reason: 'probe-failed' });
  });

  it.each([
    ['other fatal error', result({ exitCode: 128, stderr: 'fatal: detected dubious ownership in repository at /repo' })],
    ['not-a-repo text but with stdout', result({ exitCode: 128, stdout: 'x\n', stderr: 'fatal: not a git repository' })],
    ['truncated', result({ stdout: layoutOut(), truncated: true })],
    ['timed out', result({ stdout: layoutOut(), timedOut: true })],
  ])('L5 layout probe failure (%s) → fails closed', async (_label, r) => {
    const v = await probe(r);
    expect(v).toMatchObject({ kind: 'restricted', reason: 'probe-failed' });
  });

  it('L6 cwd is not inside any repository → not restricted (nothing to protect), never cached, fs untouched', async () => {
    const fs = fsMock();
    const v = await probe(result({ exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }), fs);
    expect(v).toEqual({ kind: 'trusted', cacheable: false });
    expect(fs.listDir).not.toHaveBeenCalled();
  });

  it('L7 Windows-style output (forward slashes with a drive letter) is accepted', async () => {
    const fs = fsMock({ 'C:/work/repo/.git': [] });
    const v = await probe(result({ stdout: layoutOut({ gitDir: 'C:/work/repo/.git', top: 'C:/work/repo' }) }), fs);
    expect(v).toMatchObject({ kind: 'trusted' });
  });
});

describe('probeRepoSafety symlinks inside the git directory', () => {
  const probe = (fs: unknown, layout = layoutOut()) =>
    probeRepoSafety({ shell: { exec: gitMock('', result({ stdout: layout })) }, fs } as unknown as CoPluginApp, '/repo');
  const NORMAL: Record<string, Entry[]> = {
    '/repo/.git': [file('HEAD'), file('config'), file('index'), file('packed-refs'), dir('objects'), dir('refs'), dir('logs'), dir('info'), dir('hooks'), dir('modules'), dir('lfs')],
    '/repo/.git/objects': [dir('ab'), dir('info'), dir('pack')],
    '/repo/.git/objects/info': [file('packs'), dir('commit-graphs')],
    '/repo/.git/objects/info/commit-graphs': [],
    '/repo/.git/objects/pack': [file('pack-1.pack')],
    '/repo/.git/refs': [dir('heads'), dir('tags')],
    '/repo/.git/refs/heads': [file('main'), dir('feature')],
    '/repo/.git/refs/heads/feature': [file('x')],
    '/repo/.git/refs/tags': [],
    '/repo/.git/logs': [file('HEAD'), dir('refs')],
    '/repo/.git/logs/refs': [dir('heads')],
    '/repo/.git/logs/refs/heads': [file('main')],
    '/repo/.git/info': [file('exclude')],
  };
  const withEntry = (path: string, entry: Entry) => ({ ...NORMAL, [path]: [...(NORMAL[path] ?? []), entry] });

  it('S1 an ordinary git directory is trusted; fan-out dirs, hooks, modules and lfs are never listed', async () => {
    const fs = fsMock(NORMAL);
    await expect(probe(fs)).resolves.toEqual({ kind: 'trusted', cacheable: true });
    const listed = fs.listDir.mock.calls.map((c) => c[0]).sort();
    expect(listed).toEqual(Object.keys(NORMAL).sort());
    expect(fs.lstat).toHaveBeenCalledWith('/repo/.git/objects/info/alternates');
  });

  it.each([
    ['/repo/.git', 'index', 'index'],
    ['/repo/.git', 'HEAD', 'HEAD'],
    ['/repo/.git', 'config', 'config'],
    ['/repo/.git', 'objects', 'objects'],
    ['/repo/.git', 'refs', 'refs'],
    ['/repo/.git', 'logs', 'logs'],
    ['/repo/.git', 'packed-refs', 'packed-refs'],
    ['/repo/.git', 'COMMIT_EDITMSG', 'COMMIT_EDITMSG'],
    ['/repo/.git/objects', 'cd', 'objects/cd'],
    ['/repo/.git/objects', 'pack', 'objects/pack'],
    ['/repo/.git/objects/pack', 'pack-2.idx', 'objects/pack/pack-2.idx'],
    ['/repo/.git/objects/info', 'alternates', 'objects/info/alternates'],
    ['/repo/.git/objects/info/commit-graphs', 'graph-1.graph', 'objects/info/commit-graphs/graph-1.graph'],
    ['/repo/.git/refs/heads', 'evil', 'refs/heads/evil'],
    ['/repo/.git/refs/heads/feature', 'y', 'refs/heads/feature/y'],
    ['/repo/.git/logs', 'HEAD2', 'logs/HEAD2'],
    ['/repo/.git/logs/refs/heads', 'evil', 'logs/refs/heads/evil'],
    ['/repo/.git/info', 'attributes', 'info/attributes'],
  ])('S2 a symbolic link at %s/%s → restricted, named in the message', async (path, name, rel) => {
    const tree = { ...NORMAL, [path]: [...NORMAL[path]!.filter((e) => e.name !== name), link(name)] };
    const r = await probe(fsMock(tree));
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unsafe-layout', cacheable: false });
    expect(r.kind === 'restricted' && r.message).toContain(`symbolic link (${rel})`);
  });

  it('S3 a symlinked top-level hooks directory is left to the pre-commit hooks check; a nested path named hooks is not exempt', async () => {
    const tree = { ...NORMAL, '/repo/.git': [...NORMAL['/repo/.git']!.filter((e) => e.name !== 'hooks'), link('hooks')] };
    await expect(probe(fsMock(tree))).resolves.toMatchObject({ kind: 'trusted' });
    const nested = await probe(fsMock(withEntry('/repo/.git/refs', link('hooks'))));
    expect(nested).toMatchObject({ kind: 'restricted' });
  });

  it('S4 non-empty objects/info/alternates → restricted; an empty one is fine', async () => {
    const r = await probe(fsMock(NORMAL, 20));
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unsafe-layout' });
    expect(r.kind === 'restricted' && r.message).toContain('objects/info/alternates');
    await expect(probe(fsMock(NORMAL, 0))).resolves.toMatchObject({ kind: 'trusted' });
  });

  it('S5 linked worktree inside the workspace: both the git dir and the common dir are scanned', async () => {
    const layout = layoutOut({ gitDir: '/repo/main/.git/worktrees/w', commonDir: '/repo/main/.git' });
    const tree = {
      '/repo/main/.git/worktrees/w': [file('HEAD'), file('index'), file('commondir'), dir('logs')],
      '/repo/main/.git/worktrees/w/logs': [file('HEAD')],
      '/repo/main/.git': [file('config'), dir('worktrees')],
    };
    const fs = fsMock(tree);
    await expect(probe(fs, layout)).resolves.toMatchObject({ kind: 'trusted' });
    expect(fs.lstat).toHaveBeenCalledWith('/repo/main/.git/objects/info/alternates');

    const badCommon = { ...tree, '/repo/main/.git': [link('config'), dir('worktrees')] };
    const rc = await probe(fsMock(badCommon), layout);
    expect(rc.kind === 'restricted' && rc.message).toContain('symbolic link (config)');

    const bad = { ...tree, '/repo/main/.git/worktrees/w/logs': [link('HEAD')] };
    const r = await probe(fsMock(bad), layout);
    expect(r.kind === 'restricted' && r.message).toContain('symbolic link (logs/HEAD)');
  });

  it.each([
    ['no fs api', undefined],
    ['fs without listDir', { lstat: vi.fn() }],
    ['fs without lstat', { listDir: vi.fn(async () => []) }],
    ['listDir rejects (scope not granted)', fsMock({})],
    ['lstat rejects with a non-ENOENT error', { listDir: vi.fn(async () => []), lstat: vi.fn(async () => { throw new Error('EACCES: permission denied'); }) }],
  ])('S6 the git directory cannot be inspected (%s) → restricted, asks for file access', async (_label, fs) => {
    const r = await probe(fs);
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unsafe-layout', cacheable: false });
    expect(r.kind === 'restricted' && r.message).toContain('could not be inspected');
    expect(r.kind === 'restricted' && r.message).toContain('Grant the plugin file access');
  });

  it('S7 an absurdly large directory tree under refs fails closed instead of scanning forever', async () => {
    const listDir = vi.fn(async (path: string) => (path === '/repo/.git' ? [dir('refs')] : Array.from({ length: 80 }, (_, i) => dir(`d${i}`))));
    const r = await probe({ listDir, lstat: vi.fn(async () => { throw enoent(); }) });
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unsafe-layout' });
    expect(listDir.mock.calls.length).toBeLessThan(6_000);
  });
});

describe('probeRepoSafety special files git would open (FIFO, socket, device)', () => {
  // git 打开 FIFO 即阻塞、读设备读不完:status / diff / log / commit 挂到宿主超时(untrusted-file-reads UF4–UF6)。
  const special = (name: string): Entry => ({ name, isFile: false, isDirectory: false, isSymlink: false });
  const probe = (fs: unknown) =>
    probeRepoSafety({ shell: { exec: gitMock('', result({ stdout: layoutOut() })) }, fs } as unknown as CoPluginApp, '/repo');
  const TREE: Record<string, Entry[]> = {
    '/repo/.git': [file('HEAD'), file('config'), file('index'), dir('objects'), dir('refs'), dir('info'), dir('hooks')],
    '/repo/.git/objects': [dir('info'), dir('pack')],
    '/repo/.git/objects/info': [],
    '/repo/.git/objects/pack': [],
    '/repo/.git/refs': [],
    '/repo/.git/info': [file('exclude')],
  };
  const withSpecial = (dirPath: string, name: string) => ({
    ...TREE,
    [dirPath]: [...TREE[dirPath]!.filter((e) => e.name !== name), special(name)],
  });
  /** lstat 替身:worktree 根下的文件按 types 返回类型,其余 ENOENT。 */
  const rootFs = (tree: Record<string, Entry[]>, types: Record<string, 'file' | 'dir' | 'link' | 'special' | Error> = {}) => {
    const base = fsMock(tree);
    const lstat = vi.fn(async (path: string) => {
      const t = types[path];
      if (t === undefined) throw enoent();
      if (t instanceof Error) throw t;
      return { size: 0, mtimeMs: 0, isFile: t === 'file', isDirectory: t === 'dir', isSymlink: t === 'link' };
    });
    return { listDir: base.listDir, lstat };
  };

  it.each([
    ['/repo/.git', 'packed-refs', 'packed-refs'],
    ['/repo/.git', 'shallow', 'shallow'],
    ['/repo/.git', 'index', 'index'],
    ['/repo/.git', 'COMMIT_EDITMSG', 'COMMIT_EDITMSG'],
    ['/repo/.git/info', 'exclude', 'info/exclude'],
    ['/repo/.git/info', 'attributes', 'info/attributes'],
    ['/repo/.git/info', 'grafts', 'info/grafts'],
    ['/repo/.git/info', 'sparse-checkout', 'info/sparse-checkout'],
    ['/repo/.git/objects/info', 'commit-graph', 'objects/info/commit-graph'],
    ['/repo/.git/refs', 'evil', 'refs/evil'],
  ])('S8 a file at %s/%s that is neither a regular file, a directory nor a link → restricted, named in the message', async (dirPath, name, rel) => {
    const r = await probe(fsMock(withSpecial(dirPath, name)));
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unsafe-layout', cacheable: false });
    expect(r.kind === 'restricted' && r.message).toContain(`(${rel})`);
    expect(r.kind === 'restricted' && r.message).toContain('not a regular file');
  });

  it('S9 the socket of git\'s built-in fsmonitor daemon (top of the git directory) is not a reason; the same name deeper down is', async () => {
    await expect(probe(fsMock(withSpecial('/repo/.git', 'fsmonitor--daemon.ipc')))).resolves.toMatchObject({ kind: 'trusted' });
    await expect(probe(fsMock(withSpecial('/repo/.git/info', 'fsmonitor--daemon.ipc')))).resolves.toMatchObject({ kind: 'restricted' });
  });

  it.each(['.gitignore', '.gitattributes'])('S10 %s at the top of the working tree that is a FIFO / socket / device → restricted; a regular file, directory, link or none is fine', async (name) => {
    const path = `/repo/${name}`;
    const r = await probe(rootFs(TREE, { [path]: 'special' }));
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unsafe-layout', cacheable: false });
    expect(r.kind === 'restricted' && r.message).toContain(`(${name})`);
    for (const t of ['file', 'dir', 'link'] as const) {
      await expect(probe(rootFs(TREE, { [path]: t }))).resolves.toMatchObject({ kind: 'trusted' });
    }
    await expect(probe(rootFs(TREE))).resolves.toMatchObject({ kind: 'trusted' });
    const denied = await probe(rootFs(TREE, { [path]: new Error('EACCES: permission denied') }));
    expect(denied.kind === 'restricted' && denied.message).toContain('could not be inspected');
  });
});

describe('RepoSafetyGuard cache', () => {
  function setup(stdout = '', layout?: PluginShellExecResult, fsExtra: unknown = fsMock()) {
    const exec = gitMock(stdout, layout);
    let mtime = 1;
    const stat = vi.fn(async (path: string) => ({
      size: 10,
      mtimeMs: path.endsWith('/config') ? mtime : 0,
      isFile: path.endsWith('/config'),
      isDirectory: path.endsWith('/.git'),
      isSymlink: false,
    }));
    const a = { shell: { exec }, fs: { ...(fsExtra as object), stat } } as unknown as CoPluginApp;
    return { a, exec, stat, bump: () => (mtime += 1) };
  }

  it('T10 caches by .git/config mtime+size and re-probes when it changes', async () => {
    const { a, exec, stat, bump } = setup();
    const guard = new RepoSafetyGuard(a);
    await guard.check('/repo');
    await guard.check('/repo');
    expect(exec).toHaveBeenCalledTimes(2); // 配置 + 布局各一次
    expect(stat).toHaveBeenCalledWith('/repo/.git/config');
    bump();
    await guard.check('/repo');
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('T11 fresh:true always re-probes', async () => {
    const { a, exec } = setup();
    const guard = new RepoSafetyGuard(a);
    await guard.check('/repo');
    await guard.check('/repo', { fresh: true });
    expect(configCalls(exec)).toBe(2);
  });

  it('T12 never caches when stat is unavailable (no fs grant / .git is a file)', async () => {
    const exec = gitMock();
    const stat = vi.fn(async () => {
      throw new Error('EACCES');
    });
    const guard = new RepoSafetyGuard({ shell: { exec }, fs: { ...fsMock(), stat } } as unknown as CoPluginApp);
    await guard.check('/repo');
    await guard.check('/repo');
    expect(configCalls(exec)).toBe(2);
  });

  it('T13 never caches when config uses include / includeIf (included files have their own mtime)', async () => {
    const { a, exec } = setup(z(['local', 'include.path', '../x.cfg']));
    const guard = new RepoSafetyGuard(a);
    await guard.check('/repo');
    await guard.check('/repo');
    expect(configCalls(exec)).toBe(2);

    const s2 = setup(z(['local', 'includeif.onbranch:main.path', '../x.cfg']));
    const g2 = new RepoSafetyGuard(s2.a);
    await g2.check('/repo');
    await g2.check('/repo');
    expect(configCalls(s2.exec)).toBe(2);
  });

  it('T13b entries in a scope other than global / system / command / local / unknown live in files .git/config\'s mtime says nothing about → never cached; `unknown` (Apple Git\'s bundled defaults) alone does not prevent caching', async () => {
    for (const scope of ['worktree', 'submodule', 'remote']) {
      const { a, exec } = setup(z([scope, 'user.name', 'x']));
      const guard = new RepoSafetyGuard(a);
      await guard.check('/repo');
      await guard.check('/repo');
      expect({ scope, probes: configCalls(exec) }).toEqual({ scope, probes: 2 });
    }
    const apple = setup(z(['unknown', 'credential.helper', 'osxkeychain'], ['local', 'core.bare', 'false']));
    const guard = new RepoSafetyGuard(apple.a);
    await guard.check('/repo');
    await guard.check('/repo');
    expect(configCalls(apple.exec)).toBe(1);

    const appleInclude = setup(z(['unknown', 'include.path', '/x']));
    const g2 = new RepoSafetyGuard(appleInclude.a);
    await g2.check('/repo');
    await g2.check('/repo');
    expect(configCalls(appleInclude.exec)).toBe(2);
  });

  it('T14 concurrent checks share one in-flight probe', async () => {
    const { a, exec } = setup();
    const guard = new RepoSafetyGuard(a);
    await Promise.all([guard.check('/repo'), guard.check('/repo'), guard.check('/repo')]);
    expect(configCalls(exec)).toBe(1);
  });

  it('T15 a restricted config verdict is cached too (stays restricted until config changes)', async () => {
    const { a, exec } = setup(z(['local', 'filter.x.clean', 'evil']));
    const guard = new RepoSafetyGuard(a);
    expect((await guard.check('/repo')).kind).toBe('restricted');
    expect((await guard.check('/repo')).kind).toBe('restricted');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('T15b a layout / symlink restriction is not cached: it does not depend on .git/config, so fixing it is picked up at once', async () => {
    const tree: Record<string, Entry[]> = { '/repo/.git': [link('index')] };
    const { a, exec } = setup('', undefined, fsMock(tree));
    const guard = new RepoSafetyGuard(a);
    expect((await guard.check('/repo')).kind).toBe('restricted');
    tree['/repo/.git'] = [file('index')];
    expect((await guard.check('/repo')).kind).toBe('trusted');
    expect(configCalls(exec)).toBe(2);

    const outside = setup('', result({ stdout: layoutOut({ gitDir: '/elsewhere/.git' }) }));
    const g2 = new RepoSafetyGuard(outside.a);
    await g2.check('/repo');
    await g2.check('/repo');
    expect(configCalls(outside.exec)).toBe(2);
  });
});

describe('RepoSafetyGuard.restrict (a restriction found outside the probe, e.g. a forged index)', () => {
  it('T15c restrict() makes every later check of that root return the given verdict without probing, until a fresh check; other roots are unaffected', async () => {
    const exec = gitMock(z(['local', 'core.bare', 'false']));
    const guard = new RepoSafetyGuard({ shell: { exec }, fs: fsMock() } as unknown as CoPluginApp);
    expect(await guard.check('/repo')).toEqual({ kind: 'trusted' });
    const calls = exec.mock.calls.length;

    const verdict = { kind: 'restricted', reason: 'unsafe-index', keys: [], message: 'Git commands are disabled for this repository: forged' } as const;
    guard.restrict('/repo', verdict);
    expect(await guard.check('/repo')).toBe(verdict);
    expect(await guard.check('/repo')).toBe(verdict);
    expect(exec.mock.calls.length).toBe(calls);
    expect(await guard.check('/other')).not.toBe(verdict);

    expect(await guard.check('/repo', { fresh: true })).toEqual({ kind: 'trusted' });
    expect(await guard.check('/repo')).toEqual({ kind: 'trusted' });
  });
});

describe('installRepoSafetyGuard', () => {
  it('T16 restricted repo: gitExec refuses every command and only the probe ever spawns git', async () => {
    const exec = gitMock(z(['local', 'filter.x.clean', 'evil']), undefined, result({ stdout: 'x' }));
    const a = { shell: { exec }, fs: fsMock() } as unknown as CoPluginApp;
    const installed = installRepoSafetyGuard(a);

    for (const args of [['status', '--porcelain=v1', '-z'], ['diff', '--', 'a'], ['add', '--', 'a'], ['commit', '-F', '-']]) {
      const r = await gitExec(a, '/repo', args);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('Git commands are disabled');
    }
    for (const call of exec.mock.calls) {
      expect(call[1].slice(-5)).toEqual([...PROBE_ARGS]);
    }

    installed.dispose();
    await expect(gitExec(a, '/repo', ['status'])).resolves.toMatchObject({ exitCode: 0, stdout: 'x' });
  });

  it('T16b layout-restricted repo (git dir outside / symlink inside): gitExec refuses every command; only the two probes spawn git', async () => {
    for (const [layout, fs, text] of [
      [result({ stdout: layoutOut({ gitDir: '/victim/.git' }) }), fsMock(), 'outside this folder'],
      [result({ stdout: layoutOut({ inside: 'false', top: '/etc' }) }), fsMock(), 'working tree'],
      [result({ stdout: layoutOut() }), fsMock({ '/repo/.git': [link('index')] }), 'symbolic link (index)'],
    ] as const) {
      const exec = gitMock('', layout, result({ stdout: 'leak' }));
      const a = { shell: { exec }, fs } as unknown as CoPluginApp;
      installRepoSafetyGuard(a);
      for (const args of [['status', '--porcelain=v1', '-z'], ['diff', '--', 'a'], ['checkout', '--', 'a'], ['commit', '-F', '-']]) {
        const r = await gitExec(a, '/repo', args);
        expect(r).toMatchObject({ exitCode: 128, stdout: '' });
        expect(r.stderr).toContain(text);
      }
      expect(exec.mock.calls.every((c) => isConfigProbe(c[1]) || isLayoutProbe(c[1]))).toBe(true);
    }
  });

  it('T17 trusted repo: commands run normally after the probes', async () => {
    const exec = gitMock();
    const a = { shell: { exec }, fs: fsMock() } as unknown as CoPluginApp;
    installRepoSafetyGuard(a);

    await gitExec(a, '/repo', ['status', '--porcelain=v1', '-z']);

    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls[0]![1].slice(-5)).toEqual([...PROBE_ARGS]);
    expect(exec.mock.calls[1]![1]).toContain('--is-inside-work-tree');
    expect(exec.mock.calls[2]![1]).toContain('status');
  });
});
