import { describe, expect, it, vi } from 'vitest';
import { readStatusHash } from '../../git/status-hash';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';

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
  it('T6 returns raw porcelain stdout through the read-only git wrapper', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue(result({ stdout: ' M src/a.ts\0?? notes.txt\0' }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(readStatusHash(app, '/repo')).resolves.toBe(
      ' M src/a.ts\0?? notes.txt\0',
    );
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'status', '--porcelain=v1', '-z'],
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
