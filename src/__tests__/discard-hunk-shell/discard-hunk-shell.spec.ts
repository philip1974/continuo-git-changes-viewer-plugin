import { describe, expect, it, vi } from 'vitest';
import { discardHunk } from '../../git/discard-hunk';
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

describe('discardHunk shell wrapper', () => {
  it('T1 uses git apply --reverse through stdin with no optional locks', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;
    const patch = 'diff --git a/a.ts b/a.ts\n';

    await expect(discardHunk(app, '/repo', patch)).resolves.toEqual({ ok: true });

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'apply', '--reverse', '--whitespace=nowarn', '-'],
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

    await expect(discardHunk(app, '/repo', 'patch')).resolves.toEqual({
      ok: false,
      error: 'error: patch does not apply',
    });
  });

  it('T3 falls back to a reverse exit-code message', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 128 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(discardHunk(app, '/repo', 'patch')).resolves.toEqual({
      ok: false,
      error: 'git apply --reverse exit 128',
    });
  });

  it('T4 never uses --cached because discard targets the working tree', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await discardHunk(app, '/repo', 'patch');

    expect(exec.mock.calls[0]?.[1]).not.toContain('--cached');
  });
});
