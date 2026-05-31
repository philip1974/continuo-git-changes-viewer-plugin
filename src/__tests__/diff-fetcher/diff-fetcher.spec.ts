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
  it('T1 fetches HEAD + WT + unified diff for tracked file', async () => {
    // v0.1.3: returns {original, modified, unifiedDiff, isUntracked:false} not {diff}
    const { app, exec } = makeApp(result({ stdout: 'diff --git a/a.ts b/a.ts\n' }));

    await expect(
      fetchDiff(app, '/repo', { path: 'src/a.ts', status: 'M', kind: 'text' }),
    ).resolves.toEqual({
      ok: true,
      path: 'src/a.ts',
      original: 'diff --git a/a.ts b/a.ts\n', // shared mock; real impl returns HEAD blob
      modified: 'diff --git a/a.ts b/a.ts\n', // shared mock; real impl returns WT content
      unifiedDiff: 'diff --git a/a.ts b/a.ts\n',
      isUntracked: false,
    });
    // v0.1.3 spawns 3 parallel calls: git show HEAD:<path>, cat <path>, git diff HEAD -- <path>
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'show', 'HEAD:src/a.ts'],
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(exec).toHaveBeenCalledWith(
      'cat',
      ['src/a.ts'],
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'diff', 'HEAD', '--', 'src/a.ts'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('T2 maps truncated unified diff to too-large with exact command', async () => {
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
