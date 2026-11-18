import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discardFile, SUBMODULE_DISCARD_ERROR } from '../../git/discard-file';
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

// discardFile 先问 index 这个路径是不是子模块条目(`ls-files -s`),再 checkout。按子命令给结果:
function shell(opts: { lsFiles?: Partial<PluginShellExecResult>; checkout?: Partial<PluginShellExecResult>[] } = {}) {
  const checkouts = [...(opts.checkout ?? [{}])];
  const exec = vi.fn(async (_cmd: string, args: readonly string[]) =>
    args.includes('ls-files')
      ? result(opts.lsFiles ?? { stdout: '100644 587be6b4c3f93f93c489c0111bba5596147a26cb 0\ta.ts\0' })
      : result(checkouts.length > 1 ? checkouts.shift()! : checkouts[0]!),
  );
  const calls = (sub: string) => exec.mock.calls.filter(([, args]) => args.includes(sub));
  return { app: { shell: { exec } } as unknown as CoPluginApp, exec, calls };
}

describe('discardFile shell wrapper', () => {
  it('T9 uses git checkout -- without HEAD so MM staged content is preserved', async () => {
    const { app, exec, calls } = shell();

    await discardFile(app, '/repo', 'a.ts');

    expect(exec).toHaveBeenCalledWith('git', buildGitArgs(['checkout', '--', 'a.ts']), {
      cwd: '/repo',
      env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
      timeoutMs: 10_000,
    });
    expect(calls('checkout')).toHaveLength(1);
    expect(calls('checkout')[0]?.[1]).not.toContain('HEAD');
  });

  it('T10 maps success and failure results', async () => {
    const { app } = shell({ checkout: [{ exitCode: 0 }, { exitCode: 1, stderr: 'checkout failed' }] });

    await expect(discardFile(app, '/repo', 'a.ts')).resolves.toEqual({ ok: true });
    await expect(discardFile(app, '/repo', 'a.ts')).resolves.toEqual({
      ok: false,
      error: 'checkout failed',
    });
  });

  it('T11 falls back to an exit-code message when stderr is empty', async () => {
    const { app } = shell({ checkout: [{ exitCode: 128 }] });

    await expect(discardFile(app, '/repo', 'a.ts')).resolves.toEqual({
      ok: false,
      error: 'git checkout -- exit 128',
    });
  });

  // `git checkout -- <submodule>` 以 0 退出但什么都不做:此前面板报 "Discarded sub",而条目原样还在。
  it('T12 a submodule entry (index mode 160000) is refused with an explanation and checkout is not run', async () => {
    const gitlink = '160000 2c943cce73eac743e3686b3486b10af14c86853b 0\tsub\0';
    const { app, exec, calls } = shell({ lsFiles: { stdout: gitlink } });

    const r = await discardFile(app, '/repo', 'sub');

    expect(r).toEqual({ ok: false, error: SUBMODULE_DISCARD_ERROR });
    expect(SUBMODULE_DISCARD_ERROR).toMatch(/submodule/i);
    expect(calls('checkout')).toEqual([]);
    expect(exec).toHaveBeenCalledWith('git', buildGitArgs(['ls-files', '-s', '-z', '--', 'sub']), expect.objectContaining({ cwd: '/repo' }));
    expect(exec.mock.calls.every(([cmd]) => cmd === 'git')).toBe(true);
  });

  it('T13 only the path\'s own index record counts (a directory lists the entries below it), and a probe that fails / times out / is cut short does not block the discard', async () => {
    const below = '160000 2c943cce73eac743e3686b3486b10af14c86853b 0\tdir/sub\x00100644 587be6b4c3f93f93c489c0111bba5596147a26cb 0\tdir/a.ts\0';
    for (const lsFiles of [{ stdout: below }, { exitCode: 128, stderr: 'fatal' }, { exitCode: null, timedOut: true }, { stdout: '160000 2c943cce73eac743e3686b3486b10af14c86853b 0\tdi', truncated: true }, { stdout: '' }]) {
      const { app, calls } = shell({ lsFiles });
      expect(await discardFile(app, '/repo', 'dir')).toEqual({ ok: true });
      expect(calls('checkout')).toHaveLength(1);
    }
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
