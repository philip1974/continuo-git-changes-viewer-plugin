import { describe, expect, it, vi } from 'vitest';
import { readStatusHash } from '../../git/status-hash';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';
import { buildGitArgs } from '../../git/exec';

function result(overrides: Partial<PluginShellExecResult>): PluginShellExecResult {
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

describe('readStatusHash', () => {
  it('T6 returns raw porcelain v2 stdout (it carries the HEAD / index object ids of every entry) through the read-only git wrapper', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue(result({ stdout: '1 .M N... 100644 100644 100644 aaa aaa src/a.ts\0? notes.txt\0' }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(readStatusHash(app, '/repo')).resolves.toBe(
      '1 .M N... 100644 100644 100644 aaa aaa src/a.ts\0? notes.txt\0',
    );
    expect(exec).toHaveBeenCalledWith(
      'git',
      buildGitArgs(['status', '--porcelain=v2', '-z']),
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
      }),
    );
  });

  it('T6b throws on non-zero git status', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue(result({ exitCode: 128, stderr: 'fatal: not a repo' }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(readStatusHash(app, '/repo')).rejects.toThrow(
      'git status failed: fatal: not a repo',
    );
  });
});
