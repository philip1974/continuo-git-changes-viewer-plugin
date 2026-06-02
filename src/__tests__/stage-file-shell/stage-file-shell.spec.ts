import { describe, expect, it, vi } from 'vitest';
import { stageFile } from '../../git/stage-file';
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

describe('stageFile shell wrapper', () => {
  it('T1 runs git add through shell.exec with no optional locks', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(stageFile(app, '/repo', 'new.txt')).resolves.toEqual({ ok: true });

    expect(exec).toHaveBeenCalledWith('git', ['--no-optional-locks', 'add', '--', 'new.txt'], {
      cwd: '/repo',
      env: { GIT_OPTIONAL_LOCKS: '0' },
      timeoutMs: 10_000,
    });
  });

  it('T2 maps git add failures to error results', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 1, stderr: 'add failed' }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(stageFile(app, '/repo', 'bad.txt')).resolves.toEqual({
      ok: false,
      error: 'add failed',
    });
  });

  it('T3 always uses -- before the file path', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await stageFile(app, '/repo', '--looks-like-option');

    expect(exec.mock.calls[0]?.[1]).toEqual(['--no-optional-locks', 'add', '--', '--looks-like-option']);
  });

  it('T4 falls back to an exit-code message when stderr is empty', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 128 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(stageFile(app, '/repo', 'a.ts')).resolves.toEqual({
      ok: false,
      error: 'git add exit 128',
    });
  });
});
