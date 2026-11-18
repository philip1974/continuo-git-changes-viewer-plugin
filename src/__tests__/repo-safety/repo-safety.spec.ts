import { describe, expect, it, vi } from 'vitest';
import { gitExec } from '../../git/exec';
import {
  installRepoSafetyGuard,
  isUnsafeConfigEntry,
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
  ])('T5 does not flag neutralized / non-executable key %s (documented trade-off)', (key) => {
    expect(isUnsafeConfigEntry(local(key))).toBe(false);
  });
});

describe('probeRepoSafety', () => {
  function app(r: PluginShellExecResult | undefined) {
    const exec = vi.fn().mockResolvedValue(r);
    return { app: { shell: { exec } } as unknown as CoPluginApp, exec };
  }

  it('T6 runs the read-only config probe with includes and scopes', async () => {
    const { app: a, exec } = app(result());
    await probeRepoSafety(a, '/repo');
    expect(PROBE_ARGS).toEqual(['config', '--list', '--show-scope', '--includes', '-z']);
    expect(exec.mock.calls[0]![1].slice(-5)).toEqual([...PROBE_ARGS]);
    expect(exec.mock.calls[0]![2]).toMatchObject({ cwd: '/repo' });
  });

  it('T7 trusted when no local executable key exists', async () => {
    const { app: a } = app(result({ stdout: z(['global', 'filter.lfs.clean', 'git-lfs clean'], ['local', 'core.bare', 'false']) }));
    await expect(probeRepoSafety(a, '/repo')).resolves.toMatchObject({ kind: 'trusted' });
  });

  it('T8 restricted with the offending keys listed in the message', async () => {
    const { app: a } = app(
      result({ stdout: z(['local', 'filter.x.clean', 'evil'], ['local', 'diff.external', 'evil2'], ['local', 'filter.x.clean', 'again']) }),
    );
    const r = await probeRepoSafety(a, '/repo');
    expect(r).toMatchObject({ kind: 'restricted', reason: 'unsafe-config', keys: ['filter.x.clean', 'diff.external'] });
    expect(r.kind === 'restricted' && r.message).toContain('filter.x.clean, diff.external');
  });

  it.each([
    ['non-zero exit', result({ exitCode: 129, stderr: 'error: unknown option `show-scope`' })],
    ['truncated', result({ truncated: true })],
    ['timed out', result({ timedOut: true, exitCode: null })],
    ['no result', undefined],
  ])('T9 fails closed when the probe fails (%s)', async (_label, r) => {
    const { app: a } = app(r);
    await expect(probeRepoSafety(a, '/repo')).resolves.toMatchObject({ kind: 'restricted', reason: 'probe-failed' });
  });
});

describe('RepoSafetyGuard cache', () => {
  function setup(stdout = '') {
    const exec = vi.fn().mockResolvedValue(result({ stdout }));
    let mtime = 1;
    const stat = vi.fn(async (path: string) => ({
      size: 10,
      mtimeMs: path.endsWith('/config') ? mtime : 0,
      isFile: path.endsWith('/config'),
      isDirectory: path.endsWith('/.git'),
      isSymlink: false,
    }));
    const a = { shell: { exec }, fs: { stat } } as unknown as CoPluginApp;
    return { a, exec, stat, bump: () => (mtime += 1) };
  }

  it('T10 caches by .git/config mtime+size and re-probes when it changes', async () => {
    const { a, exec, stat, bump } = setup();
    const guard = new RepoSafetyGuard(a);
    await guard.check('/repo');
    await guard.check('/repo');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith('/repo/.git/config');
    bump();
    await guard.check('/repo');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('T11 fresh:true always re-probes', async () => {
    const { a, exec } = setup();
    const guard = new RepoSafetyGuard(a);
    await guard.check('/repo');
    await guard.check('/repo', { fresh: true });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('T12 never caches when stat is unavailable (no fs grant / .git is a file)', async () => {
    const exec = vi.fn().mockResolvedValue(result());
    const stat = vi.fn(async () => {
      throw new Error('EACCES');
    });
    const guard = new RepoSafetyGuard({ shell: { exec }, fs: { stat } } as unknown as CoPluginApp);
    await guard.check('/repo');
    await guard.check('/repo');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('T13 never caches when config uses include / includeIf (included files have their own mtime)', async () => {
    const { a, exec } = setup(z(['local', 'include.path', '../x.cfg']));
    const guard = new RepoSafetyGuard(a);
    await guard.check('/repo');
    await guard.check('/repo');
    expect(exec).toHaveBeenCalledTimes(2);

    const s2 = setup(z(['local', 'includeif.onbranch:main.path', '../x.cfg']));
    const g2 = new RepoSafetyGuard(s2.a);
    await g2.check('/repo');
    await g2.check('/repo');
    expect(s2.exec).toHaveBeenCalledTimes(2);
  });

  it('T14 concurrent checks share one in-flight probe', async () => {
    const { a, exec } = setup();
    const guard = new RepoSafetyGuard(a);
    await Promise.all([guard.check('/repo'), guard.check('/repo'), guard.check('/repo')]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('T15 a restricted verdict is cached too (stays restricted until config changes)', async () => {
    const { a, exec } = setup(z(['local', 'filter.x.clean', 'evil']));
    const guard = new RepoSafetyGuard(a);
    expect((await guard.check('/repo')).kind).toBe('restricted');
    expect((await guard.check('/repo')).kind).toBe('restricted');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('installRepoSafetyGuard', () => {
  it('T16 restricted repo: gitExec refuses every command and only the probe ever spawns git', async () => {
    const exec = vi.fn().mockResolvedValue(result({ stdout: z(['local', 'filter.x.clean', 'evil']) }));
    const a = { shell: { exec } } as unknown as CoPluginApp;
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
    exec.mockResolvedValue(result({ stdout: 'x' }));
    await expect(gitExec(a, '/repo', ['status'])).resolves.toMatchObject({ exitCode: 0 });
  });

  it('T17 trusted repo: commands run normally after the probe', async () => {
    const exec = vi.fn().mockResolvedValue(result({ stdout: '' }));
    const a = { shell: { exec } } as unknown as CoPluginApp;
    installRepoSafetyGuard(a);

    await gitExec(a, '/repo', ['status', '--porcelain=v1', '-z']);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0]![1].slice(-5)).toEqual([...PROBE_ARGS]);
    expect(exec.mock.calls[1]![1]).toContain('status');
  });
});
