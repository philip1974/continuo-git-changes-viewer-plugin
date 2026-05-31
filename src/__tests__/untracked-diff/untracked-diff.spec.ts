import { describe, expect, it, vi } from 'vitest';
import { fetchDiff } from '../../git/diff-fetcher';
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

function makeApp(shellResult: PluginShellExecResult) {
  const exec = vi.fn().mockResolvedValue(shellResult);
  return {
    app: { shell: { exec } } as unknown as CoPluginApp,
    exec,
  };
}

describe('untracked diff fetcher', () => {
  it('T1 accepts git diff --no-index exit code 1 as diff exists', async () => {
    const { app, exec } = makeApp(result({ stdout: 'diff --git a/dev/null b/new.txt\n', exitCode: 1 }));

    await expect(
      fetchDiff(app, '/repo', { path: 'new.txt', status: 'U', kind: 'text' }),
    ).resolves.toEqual({
      ok: true,
      path: 'new.txt',
      diff: 'diff --git a/dev/null b/new.txt\n',
    });
    expect(exec).toHaveBeenCalledWith(
      'git',
      [
        '--no-optional-locks',
        'diff',
        '--no-index',
        '--binary',
        '--no-color',
        '/dev/null',
        'new.txt',
      ],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('T2 maps truncated untracked diff to too-large placeholder', async () => {
    const { app } = makeApp(result({ stdout: 'partial', exitCode: 1, truncated: true }));

    await expect(
      fetchDiff(app, '/repo', { path: 'new.txt', status: 'U', kind: 'text' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'too-large',
      path: 'new.txt',
      exactCommand:
        'git diff --no-index --binary --no-color /dev/null new.txt',
    });
  });
});
