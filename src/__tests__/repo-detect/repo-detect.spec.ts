import { describe, expect, it, vi } from 'vitest';
import { detectRepo } from '../../git/repo-detect';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';

function result(partial: Partial<PluginShellExecResult>): PluginShellExecResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    ...partial,
  };
}

function makeApp(root: string | null, shellResult: PluginShellExecResult) {
  const exec = vi.fn().mockResolvedValue(shellResult);
  return {
    app: {
      workspace: { getRoot: vi.fn().mockResolvedValue(root) },
      shell: { exec },
    } as unknown as CoPluginApp,
    exec,
  };
}

describe('repo detection', () => {
  it('T1 returns ok when workspace root is git top level', async () => {
    const { app, exec } = makeApp('/repo', result({ stdout: '\n' }));

    await expect(detectRepo(app)).resolves.toEqual({
      ok: true,
      root: '/repo',
    });
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'rev-parse', '--show-prefix'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('T2 returns not-git-root when workspace root is a subdirectory', async () => {
    const { app } = makeApp('/repo/packages/app', result({ stdout: 'packages/app/\n' }));

    await expect(detectRepo(app)).resolves.toEqual({
      ok: false,
      reason: 'not-git-root',
      root: '/repo/packages/app',
      prefix: 'packages/app/',
    });
  });

  it('T3 returns not-git-root when git exits non-zero', async () => {
    const { app } = makeApp(
      '/tmp/not-repo',
      result({ exitCode: 128, stderr: 'fatal: not a git repository' }),
    );

    await expect(detectRepo(app)).resolves.toMatchObject({
      ok: false,
      reason: 'not-git-root',
      root: '/tmp/not-repo',
    });
  });

  it('T4 does not compare path strings for symlink-spelled workspace roots', async () => {
    const { app } = makeApp('/var/tmp/repo-link', result({ stdout: '' }));

    await expect(detectRepo(app)).resolves.toEqual({
      ok: true,
      root: '/var/tmp/repo-link',
    });
  });
});
