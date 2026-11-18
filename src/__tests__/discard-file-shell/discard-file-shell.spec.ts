import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIRECTORY_DISCARD_ERROR, discardFile, parentNotDirectoryDiscardError, SUBMODULE_DISCARD_ERROR } from '../../git/discard-file';
import { UNVERIFIED_PATH_ERROR } from '../../git/worktree-entry';
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
const FILE_STAT = { size: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false };
const DIR_STAT = { ...FILE_STAT, isFile: false, isDirectory: true };
const enoent = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });

function shell(opts: { lsFiles?: Partial<PluginShellExecResult>; checkout?: Partial<PluginShellExecResult>[]; lstat?: (path: string) => Promise<typeof FILE_STAT> } = {}) {
  const checkouts = [...(opts.checkout ?? [{}])];
  const exec = vi.fn(async (_cmd: string, args: readonly string[]) =>
    args.includes('ls-files')
      ? result(opts.lsFiles ?? { stdout: '100644 587be6b4c3f93f93c489c0111bba5596147a26cb 0\ta.ts\0' })
      : result(checkouts.length > 1 ? checkouts.shift()! : checkouts[0]!),
  );
  const calls = (sub: string) => exec.mock.calls.filter(([, args]) => args.includes(sub));
  // discardFile 还要看工作树里这个位置现在是什么(app.fs.lstat,见 T14–T16):默认是普通文件
  const lstat = vi.fn(opts.lstat ?? (async () => FILE_STAT));
  return { app: { shell: { exec }, fs: { lstat } } as unknown as CoPluginApp, exec, calls, lstat };
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
  // `git checkout -- x` 在 x 的位置上是目录时递归删掉整个目录(real-git R77)
  describe('what sits at the path now is looked at before the checkout', () => {
    it('T14 a directory at the path → refused with an explanation, checkout is not run; the wording says what would have been lost', async () => {
      const { app, calls, lstat } = shell({ lstat: async () => DIR_STAT });
      expect(await discardFile(app, '/repo', 'x')).toEqual({ ok: false, error: DIRECTORY_DISCARD_ERROR });
      expect(calls('checkout')).toEqual([]);
      expect(lstat).toHaveBeenCalledWith('/repo/x');
      expect(DIRECTORY_DISCARD_ERROR).toBe(
        'A directory now sits where this file was. Discarding would delete that directory and everything in it, including files git does not track. Nothing was changed — move the directory away yourself, or use git in a terminal.',
      );
    });

    it('T15 a file or link where a parent folder was → refused, naming that parent; checkout is not run', async () => {
      const { app, calls } = shell({ lstat: async (path) => (path === '/repo/a' ? FILE_STAT : Promise.reject(enoent())) });
      expect(await discardFile(app, '/repo', 'a/b.ts')).toEqual({ ok: false, error: parentNotDirectoryDiscardError('a') });
      expect(parentNotDirectoryDiscardError('a')).toBe(
        '"a" is no longer a folder: a file or link now sits there. Discarding would delete it to restore this file. Nothing was changed — move it away yourself, or use git in a terminal.',
      );
      expect(calls('checkout')).toEqual([]);
    });

    it('T16 fail-closed when the path cannot be looked at (no file access, or lstat fails with something other than not-found); a missing file, a regular file, a symbolic link and a FIFO are checked out as before', async () => {
      const noFs = shell();
      expect(await discardFile({ shell: noFs.app.shell } as unknown as CoPluginApp, '/repo', 'a.ts')).toEqual({ ok: false, error: UNVERIFIED_PATH_ERROR });
      expect(noFs.calls('checkout')).toEqual([]);
      const denied = shell({ lstat: async () => Promise.reject(new Error('ScopeError: path is outside granted scopes')) });
      expect(await discardFile(denied.app, '/repo', 'a.ts')).toEqual({ ok: false, error: UNVERIFIED_PATH_ERROR });
      expect(denied.calls('checkout')).toEqual([]);

      for (const lstat of [
        async () => Promise.reject(enoent()),
        async () => FILE_STAT,
        async () => ({ ...FILE_STAT, isFile: false, isSymlink: true }),
        async () => ({ ...FILE_STAT, isFile: false }),
      ]) {
        const ok = shell({ lstat });
        expect(await discardFile(ok.app, '/repo', 'a.ts')).toEqual({ ok: true });
        expect(ok.calls('checkout')).toHaveLength(1);
      }
    });

    it('T17 a submodule entry is still answered as a submodule (its path is a directory too), before the working tree is looked at', async () => {
      const gitlink = '160000 2c943cce73eac743e3686b3486b10af14c86853b 0\tsub\0';
      const { app, lstat } = shell({ lsFiles: { stdout: gitlink }, lstat: async () => DIR_STAT });
      expect(await discardFile(app, '/repo', 'sub')).toEqual({ ok: false, error: SUBMODULE_DISCARD_ERROR });
      expect(lstat).not.toHaveBeenCalled();
    });
  });
});
