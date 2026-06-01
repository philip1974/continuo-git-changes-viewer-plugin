import { describe, expect, it, vi } from 'vitest';
import { stageHunk } from '../../git/stage-hunk';
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

describe('stageHunk shell wrapper', () => {
  it('T5 uses shell.exec(cmd, args, opts) with input and no optional locks', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;
    const patch = 'diff --git a/a.ts b/a.ts\n';

    await expect(stageHunk(app, '/repo', patch)).resolves.toEqual({ ok: true });

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'apply', '--cached', '--whitespace=nowarn', '-'],
      {
        cwd: '/repo',
        input: patch,
        env: { GIT_OPTIONAL_LOCKS: '0' },
        timeoutMs: 10_000,
      },
    );
  });

  it('T6 maps non-zero git apply failures to an error result', async () => {
    const exec = vi.fn().mockResolvedValue(result({
      exitCode: 1,
      stderr: 'error: patch failed',
    }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(stageHunk(app, '/repo', 'patch')).resolves.toEqual({
      ok: false,
      error: 'error: patch failed',
    });
  });

  it('T7 falls back to an exit-code message when stderr is empty', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 128 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(stageHunk(app, '/repo', 'patch')).resolves.toEqual({
      ok: false,
      error: 'git apply exit 128',
    });
  });
});
