import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repos: string[] = [];

async function git(cwd: string, args: readonly string[], input?: string) {
  const result = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function makeRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'cgv-discard-'));
  repos.push(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await writeFile(join(repo, 'file.txt'), 'one\nold\nthree\n');
  await git(repo, ['add', 'file.txt']);
  await git(repo, ['commit', '-m', 'base']);
  return repo;
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })));
});

describe('git apply --reverse discard hunk integration', () => {
  it('T25 reverses a minimal working-tree M hunk patch', async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, 'file.txt'), 'one\nnew\nthree\n');
    const { stdout: patch } = await git(repo, ['diff', '--', 'file.txt']);

    await git(repo, ['apply', '--reverse', '--whitespace=nowarn', '-'], patch);

    await expect(readFile(join(repo, 'file.txt'), 'utf8')).resolves.toBe('one\nold\nthree\n');
    const { stdout: status } = await git(repo, ['status', '--porcelain=v1']);
    expect(status).toBe('');
  });

  it('T26 clears only the working-tree hunk for MM files and preserves the staged hunk', async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, 'file.txt'), 'ONE\nold\nthree\n');
    await git(repo, ['add', 'file.txt']);
    await writeFile(join(repo, 'file.txt'), 'ONE\nnew\nthree\n');
    const { stdout: patch } = await git(repo, ['diff', '--', 'file.txt']);

    await git(repo, ['apply', '--reverse', '--whitespace=nowarn', '-'], patch);

    await expect(readFile(join(repo, 'file.txt'), 'utf8')).resolves.toBe('ONE\nold\nthree\n');
    const { stdout: workingDiff } = await git(repo, ['diff', '--', 'file.txt']);
    const { stdout: stagedDiff } = await git(repo, ['diff', '--cached', '--', 'file.txt']);
    expect(workingDiff).toBe('');
    expect(stagedDiff).toContain('-one');
    expect(stagedDiff).toContain('+ONE');
  });

  it('T27 rejects a stale patch and leaves the current working tree unchanged', async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, 'file.txt'), 'one\nnew\nthree\n');
    const { stdout: patch } = await git(repo, ['diff', '--', 'file.txt']);
    await writeFile(join(repo, 'file.txt'), 'one\nother\nthree\n');

    await expect(git(repo, ['apply', '--reverse', '--whitespace=nowarn', '-'], patch)).rejects.toThrow();

    await expect(readFile(join(repo, 'file.txt'), 'utf8')).resolves.toBe('one\nother\nthree\n');
  });
});
