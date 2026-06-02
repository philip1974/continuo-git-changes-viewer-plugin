import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  formatGitCommitError,
  gitCommit,
  readLastCommitSubject,
} from '../../git/git-commit';
import type {
  CoPluginApp,
  PluginShellExecOptions,
  PluginShellExecResult,
} from '../../sdk/types';

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

function git(cwd: string, args: readonly string[], input?: string): PluginShellExecResult {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8' });
  return result({
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.status,
    signal: r.signal,
  });
}

describe('gitCommit shell wrapper', () => {
  it('T1 maps successful git commit to ok true', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));

    await expect(gitCommit(appWithExec(exec), '/repo', 'subject')).resolves.toEqual({ ok: true });
  });

  it('T2 maps failed git commit to an error result', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 1, stderr: 'hook failed' }));

    await expect(gitCommit(appWithExec(exec), '/repo', 'subject')).resolves.toMatchObject({
      ok: false,
      error: 'hook failed',
      stderr: 'hook failed',
      exitCode: 1,
    });
  });

  it('T3 uses git commit -F - with no optional locks', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));

    await gitCommit(appWithExec(exec), '/repo', 'subject');

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'commit', '-F', '-'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('T4 passes the commit message through stdin input', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const message = 'subject\n\nbody line 1\nbody line 2\n';

    await gitCommit(appWithExec(exec), '/repo', message);

    expect(exec).toHaveBeenCalledWith(
      'git',
      expect.anything(),
      expect.objectContaining({ input: message }),
    );
  });

  it('T5 sets GIT_OPTIONAL_LOCKS=0', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));

    await gitCommit(appWithExec(exec), '/repo', 'subject');

    expect(exec).toHaveBeenCalledWith(
      'git',
      expect.anything(),
      expect.objectContaining({ env: { GIT_OPTIONAL_LOCKS: '0' } }),
    );
  });

  it('T6 uses a 120s timeout for commit hooks', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));

    await gitCommit(appWithExec(exec), '/repo', 'subject');

    expect(exec).toHaveBeenCalledWith(
      'git',
      expect.anything(),
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('T7 preserves multi-line messages through stdin in a real temp repo', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cgv-commit-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.name', 'Commit Probe']);
    git(repo, ['config', 'user.email', 'commit-probe@example.com']);
    spawnSync('sh', ['-c', 'printf "one\\n" > a.txt'], { cwd: repo });
    git(repo, ['add', 'a.txt']);

    const exec = vi.fn(
      async (cmd: string, args: readonly string[], opts?: PluginShellExecOptions) => {
        expect(cmd).toBe('git');
        return git(opts?.cwd ?? repo, args, opts?.input);
      },
    );
    const message = 'subject line\n\nbody line 1\nbody line 2\n';

    await expect(gitCommit(appWithExec(exec), repo, message)).resolves.toEqual({ ok: true });

    const logged = git(repo, ['log', '-1', '--pretty=%B']);
    expect(logged.stdout).toContain('subject line\n\nbody line 1\nbody line 2');
  });

  it('T8 formats timed out commits before other output', () => {
    expect(formatGitCommitError({
      timedOut: true,
      stderr: 'late stderr',
      exitCode: null,
    })).toBe('Commit timed out after 120s');
  });

  it('T9 reads the real last commit subject after success', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0, stdout: 'hook subject\n' }));

    await expect(readLastCommitSubject(appWithExec(exec), '/repo')).resolves.toBe('hook subject');
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'log', '-1', '--pretty=%s'],
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it('T10 returns null when the last subject cannot be read', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 128, stderr: 'no commits' }));

    await expect(readLastCommitSubject(appWithExec(exec), '/repo')).resolves.toBeNull();
  });
});

