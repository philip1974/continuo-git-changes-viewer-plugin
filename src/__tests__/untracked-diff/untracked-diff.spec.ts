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

// v0.1.3+: untracked 不再走 `git diff --no-index`，改用 `cat <path>` 拿 WT 全文，
// DiffView 走 NewFileView 渲染（没 unified diff 概念）。
describe('untracked diff fetcher', () => {
  it('T1 reads WT file via cat and returns isUntracked:true', async () => {
    const { app, exec } = makeApp(result({ stdout: 'hello untracked\n', exitCode: 0 }));

    await expect(
      fetchDiff(app, '/repo', { path: 'new.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' }),
    ).resolves.toEqual({
      ok: true,
      path: 'new.txt',
      original: '',
      modified: 'hello untracked\n',
      unifiedDiff: '',
      isUntracked: true,
    });
    expect(exec).toHaveBeenCalledWith(
      'cat',
      ['new.txt'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('T2 unreadable file (cat exit !== 0) returns empty modified', async () => {
    const { app } = makeApp(result({ stdout: '', stderr: 'permission denied', exitCode: 1 }));

    await expect(
      fetchDiff(app, '/repo', { path: 'locked.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' }),
    ).resolves.toEqual({
      ok: true,
      path: 'locked.txt',
      original: '',
      modified: '',
      unifiedDiff: '',
      isUntracked: true,
    });
  });
});
