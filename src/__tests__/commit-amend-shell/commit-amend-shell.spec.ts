import { describe, expect, it, vi } from 'vitest';
import { gitCommit } from '../../git/git-commit';
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

function appWithExec(exec: ReturnType<typeof vi.fn>): CoPluginApp {
  return { shell: { exec } } as unknown as CoPluginApp;
}

describe('gitCommit amend shell wrapper', () => {
  it('T9 passes --amend when amend mode is enabled', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));

    await gitCommit(appWithExec(exec), '/repo', 'subject', { amend: true });

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'commit', '--amend', '-F', '-'],
      expect.objectContaining({
        cwd: '/repo',
        input: 'subject',
        timeoutMs: 120_000,
      }),
    );
  });

  it('T10 keeps vanilla commit args unchanged by default', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));

    await gitCommit(appWithExec(exec), '/repo', 'subject');

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'commit', '-F', '-'],
      expect.objectContaining({ input: 'subject' }),
    );
  });

  it('T11 maps amend success to ok true', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));

    await expect(gitCommit(appWithExec(exec), '/repo', 'subject', { amend: true }))
      .resolves.toEqual({ ok: true });
  });

  it('T12 maps amend failure through formatGitCommitError', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 1, stderr: 'amend failed' }));

    await expect(gitCommit(appWithExec(exec), '/repo', 'subject', { amend: true }))
      .resolves.toMatchObject({ ok: false, error: 'amend failed' });
  });

  it('T13 accepts an explicit amend false option without changing args', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));

    await gitCommit(appWithExec(exec), '/repo', 'subject', { amend: false });

    expect(exec.mock.calls[0]?.[1]).toEqual(['--no-optional-locks', 'commit', '-F', '-']);
  });
});

