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

describe('tracked diff fetcher', () => {
  it('T1 fetches tracked unified diff against HEAD', async () => {
    const { app, exec } = makeApp(result({ stdout: 'diff --git a/a.ts b/a.ts\n' }));

    await expect(
      fetchDiff(app, '/repo', { path: 'src/a.ts', status: 'M', kind: 'text' }),
    ).resolves.toEqual({
      ok: true,
      path: 'src/a.ts',
      diff: 'diff --git a/a.ts b/a.ts\n',
    });
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'diff', 'HEAD', '--', 'src/a.ts'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('T2 maps truncated output to too-large with exact command', async () => {
    const { app } = makeApp(result({ stdout: 'partial', truncated: true }));

    await expect(
      fetchDiff(app, '/repo', { path: 'large.txt', status: 'M', kind: 'text' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'too-large',
      path: 'large.txt',
      exactCommand: 'git diff HEAD -- large.txt',
    });
  });
});
