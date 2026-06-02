import { describe, expect, it, vi } from 'vitest';
import {
  hasHeadCommit,
  readHeadMessage,
  readHeadSha,
} from '../../git/head-meta';
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

describe('HEAD metadata shell helpers', () => {
  it('T1 hasHeadCommit returns true when HEAD verifies', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));

    await expect(hasHeadCommit(appWithExec(exec), '/repo')).resolves.toBe(true);
  });

  it('T2 hasHeadCommit returns false when HEAD is absent', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 128 }));

    await expect(hasHeadCommit(appWithExec(exec), '/repo')).resolves.toBe(false);
  });

  it('T3 readHeadMessage returns subject and body', async () => {
    const exec = vi.fn().mockResolvedValue(result({
      exitCode: 0,
      stdout: 'subject\n\nbody line 1\nbody line 2\n\n',
    }));

    await expect(readHeadMessage(appWithExec(exec), '/repo')).resolves.toBe(
      'subject\n\nbody line 1\nbody line 2',
    );
  });

  it('T4 readHeadMessage trims only trailing newlines', async () => {
    const exec = vi.fn().mockResolvedValue(result({
      exitCode: 0,
      stdout: ' subject \n\n  indented body  \n\n\n',
    }));

    await expect(readHeadMessage(appWithExec(exec), '/repo')).resolves.toBe(
      ' subject \n\n  indented body  ',
    );
  });

  it('T5 readHeadMessage returns null on git failure', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 128 }));

    await expect(readHeadMessage(appWithExec(exec), '/repo')).resolves.toBeNull();
  });

  it('T6 readHeadSha returns the current HEAD sha', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0, stdout: 'abc123\n' }));

    await expect(readHeadSha(appWithExec(exec), '/repo')).resolves.toBe('abc123');
  });

  it('T7 readHeadSha returns null on git failure', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 128 }));

    await expect(readHeadSha(appWithExec(exec), '/repo')).resolves.toBeNull();
  });

  it('T8 uses no optional locks for HEAD metadata reads', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0, stdout: 'abc123\n' }));

    await readHeadSha(appWithExec(exec), '/repo');

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'rev-parse', 'HEAD'],
      expect.objectContaining({
        cwd: '/repo',
        env: { GIT_OPTIONAL_LOCKS: '0' },
        timeoutMs: 5_000,
      }),
    );
  });
});

