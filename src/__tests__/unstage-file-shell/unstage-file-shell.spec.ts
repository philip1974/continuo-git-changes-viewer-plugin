import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetRestoreCache, unstageFile } from '../../git/unstage-file';
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

beforeEach(() => _resetRestoreCache());

describe('unstageFile shell wrapper', () => {
  it('T5 uses git restore --staged when restore support is detected', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(unstageFile(app, '/repo', 'a.ts')).resolves.toEqual({ ok: true });

    expect(exec).toHaveBeenNthCalledWith(1, 'git', ['--no-optional-locks', 'restore', '-h'], {
      cwd: '/repo',
      env: { GIT_OPTIONAL_LOCKS: '0' },
      timeoutMs: 5_000,
    });
    expect(exec).toHaveBeenNthCalledWith(2, 'git', ['--no-optional-locks', 'restore', '--staged', '--', 'a.ts'], {
      cwd: '/repo',
      env: { GIT_OPTIONAL_LOCKS: '0' },
      timeoutMs: 10_000,
    });
  });

  it('T6 uses git reset HEAD when restore support is unavailable', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: 'unknown command: restore' }))
      .mockResolvedValueOnce(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(unstageFile(app, '/repo', 'a.ts')).resolves.toEqual({ ok: true });

    expect(exec).toHaveBeenNthCalledWith(2, 'git', ['--no-optional-locks', 'reset', 'HEAD', '--', 'a.ts'], {
      cwd: '/repo',
      env: { GIT_OPTIONAL_LOCKS: '0' },
      timeoutMs: 10_000,
    });
  });

  it('T7 caches restore support across calls', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await unstageFile(app, '/repo', 'a.ts');
    await unstageFile(app, '/repo', 'b.ts');

    expect(exec.mock.calls.filter((call) => (call[1] as string[]).includes('-h'))).toHaveLength(1);
    expect(exec).toHaveBeenLastCalledWith('git', ['--no-optional-locks', 'restore', '--staged', '--', 'b.ts'], expect.anything());
  });

  it('T8 reset helper clears the restore capability cache', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: 'unknown command: restore' }))
      .mockResolvedValueOnce(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await unstageFile(app, '/repo', 'a.ts');
    _resetRestoreCache();
    await unstageFile(app, '/repo', 'b.ts');

    expect(exec.mock.calls.filter((call) => (call[1] as string[]).includes('-h'))).toHaveLength(2);
    expect(exec).toHaveBeenLastCalledWith('git', ['--no-optional-locks', 'reset', 'HEAD', '--', 'b.ts'], expect.anything());
  });
});
