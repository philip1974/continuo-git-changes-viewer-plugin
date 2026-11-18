import { describe, expect, it, vi } from 'vitest';
import { stageFile } from '../../git/stage-file';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';
import { buildGitArgs } from '../../git/exec';

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

    expect(exec).toHaveBeenCalledWith('git', buildGitArgs(['add', '--', 'new.txt']), {
      cwd: '/repo',
      env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
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

    expect(exec.mock.calls[0]?.[1]).toEqual(buildGitArgs(['add', '--', '--looks-like-option']));
  });

  it('T4 falls back to an exit-code message when stderr is empty', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 128 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(stageFile(app, '/repo', 'a.ts')).resolves.toEqual({
      ok: false,
      error: 'git add exit 128',
    });
  });

  it('T5 an untracked path is added with the repository\'s own core.precomposeUnicode (its name was read from the directory under that setting); a tracked path pins it to false', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;
    const pin = 'core.precomposeUnicode=false';

    await stageFile(app, '/repo', 'caf\u00e9.txt', { untracked: true });
    expect(exec.mock.calls[0]?.[1]).toEqual(buildGitArgs(['add', '--', 'caf\u00e9.txt'], { untrackedPathArgs: true }));
    expect(exec.mock.calls[0]?.[1]).not.toContain(pin);

    await stageFile(app, '/repo', 'cafe\u0301.txt');
    await stageFile(app, '/repo', 'cafe\u0301.txt', { untracked: false });
    expect(exec.mock.calls[1]?.[1]).toContain(pin);
    expect(exec.mock.calls[2]?.[1]).toContain(pin);
  });
});
