import { describe, expect, it, vi } from 'vitest';
import { unstageHunk } from '../../git/unstage-hunk';
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

describe('unstageHunk shell wrapper', () => {
  it('T1 uses git apply --cached --reverse through stdin with no optional locks', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;
    const patch = 'diff --git a/a.ts b/a.ts\n';

    await expect(unstageHunk(app, '/repo', patch)).resolves.toEqual({ ok: true });

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'apply', '--cached', '--reverse', '--whitespace=nowarn', '-'],
      {
        cwd: '/repo',
        input: patch,
        env: { GIT_OPTIONAL_LOCKS: '0' },
        timeoutMs: 10_000,
      },
    );
  });

  it('T2 maps reverse-apply failures to an error result', async () => {
    const exec = vi.fn().mockResolvedValue(result({
      exitCode: 1,
      stderr: 'error: patch does not apply',
    }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(unstageHunk(app, '/repo', 'patch')).resolves.toEqual({
      ok: false,
      error: 'error: patch does not apply',
    });
  });

  it('T3 falls back to a reverse exit-code message', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 128 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(unstageHunk(app, '/repo', 'patch')).resolves.toEqual({
      ok: false,
      error: 'git apply --reverse exit 128',
    });
  });
});
