import { describe, expect, it, vi } from 'vitest';
import { gitExec } from '../../git/exec';
import {
  installRepoSafetyGuard,
  isRedirectConfigEntry,
  isUnsafeConfigEntry,
  LAYOUT_PROBE_ARGS,
  parseScopedConfigList,
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

/** exec 替身:配置探测返回 config,布局探测返回 layout,其余命令返回 other。 */
function gitMock(config = '', layout: PluginShellExecResult = result({ stdout: layoutOut() }), other = result()) {
  return vi.fn(async (_cmd: string, args: readonly string[], _opts?: unknown) =>
    isConfigProbe(args) ? result({ stdout: config }) : isLayoutProbe(args) ? layout : other,
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
  ])('T2 flags executable key %s in local scope', (key) => {
    expect(isUnsafeConfigEntry(local(key))).toBe(true);
    expect(isUnsafeConfigEntry({ scope: 'worktree', key, value: 'x' })).toBe(true);
  });

  it('T3 trusts global/system/command scopes (user-owned config)', () => {
    for (const scope of ['global', 'system', 'command', 'unknown']) {
      expect(isUnsafeConfigEntry({ scope, key: 'filter.lfs.clean', value: 'git-lfs clean' })).toBe(false);
    }
  });

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
    'core.excludesfile',
    'core.attributesfile',
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
