import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discardFile } from '../../git/discard-file';
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

const repos: string[] = [];

function git(cwd: string, args: readonly string[], input?: string) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `git ${args.join(' ')} failed`);
  return { stdout: r.stdout, stderr: r.stderr };
}

async function makeRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'cgv-file-discard-'));
  repos.push(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  await writeFile(join(repo, 'file.txt'), 'one\nold\nthree\n');
  git(repo, ['add', 'file.txt']);
  git(repo, ['commit', '-m', 'base']);
  return repo;
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })));
});

describe('discardFile shell wrapper', () => {
  it('T9 uses git checkout -- without HEAD so MM staged content is preserved', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await discardFile(app, '/repo', 'a.ts');

    expect(exec).toHaveBeenCalledWith('git', ['--no-optional-locks', 'checkout', '--', 'a.ts'], {
      cwd: '/repo',
      env: { GIT_OPTIONAL_LOCKS: '0' },
      timeoutMs: 10_000,
    });
    expect(exec.mock.calls[0]?.[1]).not.toContain('HEAD');
  });

  it('T10 maps success and failure results', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: 'checkout failed' }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(discardFile(app, '/repo', 'a.ts')).resolves.toEqual({ ok: true });
    await expect(discardFile(app, '/repo', 'a.ts')).resolves.toEqual({
      ok: false,
      error: 'checkout failed',
    });
  });

  it('T11 falls back to an exit-code message when stderr is empty', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 128 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(discardFile(app, '/repo', 'a.ts')).resolves.toEqual({
      ok: false,
      error: 'git checkout -- exit 128',
    });
  });

  it('T_MM real git probe: working-tree checkout preserves staged MM content', async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, 'file.txt'), 'ONE\nold\nthree\n');
    git(repo, ['add', 'file.txt']);
    await writeFile(join(repo, 'file.txt'), 'ONE\nnew\nthree\n');

    git(repo, ['checkout', '--', 'file.txt']);

    await expect(readFile(join(repo, 'file.txt'), 'utf8')).resolves.toBe('ONE\nold\nthree\n');
    expect(git(repo, ['diff', '--', 'file.txt']).stdout).toBe('');
    const staged = git(repo, ['diff', '--cached', '--', 'file.txt']).stdout;
    expect(staged).toContain('-one');
    expect(staged).toContain('+ONE');
  });
});
