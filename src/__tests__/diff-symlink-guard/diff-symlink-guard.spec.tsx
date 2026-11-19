// @vitest-environment jsdom
// 工作树全文读取(cat)不得跟随符号链接:真实 git + 真实文件系统构造恶意工作树,
// 断言 workspace 之外的文件内容不会进入 DiffResult / 面板。
import React from 'react';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchDiff } from '../../git/diff-fetcher';
import { scanStatus, type FileChange } from '../../git/status-scanner';
import { DiffView } from '../../panel/DiffView';
import { createGitStore } from '../../state/git-store';
import type { CoPluginApp, PluginShellExecOptions, PluginShellExecResult } from '../../sdk/types';

const SECRET = 'TOP-SECRET-OUTSIDE-WORKSPACE';

function realApp(): { app: CoPluginApp; exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(
    (cmd: string, args: readonly string[], opts: PluginShellExecOptions = {}) =>
      new Promise<PluginShellExecResult>((resolve) => {
        const child = spawn(cmd, [...args], { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code, signal) =>
          resolve({ stdout, stderr, exitCode: code, signal, timedOut: false, truncated: false }),
        );
        child.stdin.on('error', () => {});
        child.stdin.end(opts.input ?? '');
      }),
  );
  const lstat = async (p: string) => {
    const s = lstatSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink() };
  };
  return { app: { shell: { exec }, fs: { lstat } } as unknown as CoPluginApp, exec };
}

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ENV, encoding: 'utf8' });
}

const catCalls = (exec: ReturnType<typeof vi.fn>) => exec.mock.calls.filter((c) => c[0] === 'cat');
const untracked = (path: string): FileChange => ({ path, status: 'U', statusX: '?', statusY: '?', kind: 'text' });

let base: string;
let repo: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cgv-symlink-')));
  repo = join(base, 'repo');
  outside = join(base, 'outside');
  mkdirSync(repo);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), `${SECRET}\n`);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'notes.txt'), 'one\n');
  mkdirSync(join(repo, 'dir'));
  writeFileSync(join(repo, 'dir', 'secret.txt'), 'inner\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
});

afterEach(() => {
  cleanup();
  rmSync(base, { recursive: true, force: true });
});

describe('diff symlink guard (real git)', () => {
  it('T1 tracked file replaced by a link to an outside file: no outside content, git diff still shown', async () => {
    rmSync(join(repo, 'notes.txt'));
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'notes.txt'));
    const { app, exec } = realApp();
    const changes = await scanStatus(app, repo);
    const change = changes.find((c) => c.path === 'notes.txt')!;
    expect(change).toBeTruthy();

    const diff = await fetchDiff(app, repo, change);

    expect(JSON.stringify(diff)).not.toContain(SECRET);
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.modified).toBe('');
    expect(diff.withheld).toBe('symlink');
    expect(diff.original).toBe('one\n');
    // git 自己给出的信息:链接目标路径文本
    expect(diff.unifiedDiff).toContain(join(outside, 'secret.txt'));
    expect(catCalls(exec)).toEqual([]);
  });

  it('T2 untracked link to an outside file: content withheld', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'new.txt'));
    const { app, exec } = realApp();
    const changes = await scanStatus(app, repo);
    const change = changes.find((c) => c.path === 'new.txt')!;
    expect(change.status).toBe('U');

    const diff = await fetchDiff(app, repo, change);

    expect(JSON.stringify(diff)).not.toContain(SECRET);
    expect(diff).toMatchObject({ ok: true, modified: '', isUntracked: true, withheld: 'symlink' });
    expect(catCalls(exec)).toEqual([]);
  });

  it('T3 parent directory is a link to an outside directory: content withheld', async () => {
    rmSync(join(repo, 'dir'), { recursive: true });
    symlinkSync(outside, join(repo, 'dir'));
    const { app, exec } = realApp();

    // git 自己把 dir/secret.txt 报成删除;这里覆盖状态过期(扫描后目录才被换成链接)与未跟踪两种入口
    for (const change of [
      untracked('dir/secret.txt'),
      { path: 'dir/secret.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' } as FileChange,
    ]) {
      const diff = await fetchDiff(app, repo, change);
      expect(JSON.stringify(diff)).not.toContain(SECRET);
      expect(diff).toMatchObject({ ok: true, modified: '', withheld: 'symlink' });
    }
    expect(catCalls(exec)).toEqual([]);
  });

  it('T3b deeper parent link (a/link/b/file) is caught too', async () => {
    mkdirSync(join(outside, 'b'));
    writeFileSync(join(outside, 'b', 'file.txt'), `${SECRET}\n`);
    mkdirSync(join(repo, 'a'));
    symlinkSync(outside, join(repo, 'a', 'link'));
    const { app, exec } = realApp();

    const diff = await fetchDiff(app, repo, untracked('a/link/b/file.txt'));

    expect(JSON.stringify(diff)).not.toContain(SECRET);
    expect(diff).toMatchObject({ ok: true, modified: '', withheld: 'symlink' });
    expect(catCalls(exec)).toEqual([]);
  });

  it('T4 regular tracked / untracked / nested files are read as before', async () => {
    writeFileSync(join(repo, 'notes.txt'), 'one\ntwo\n');
    writeFileSync(join(repo, 'dir', 'fresh.txt'), 'fresh\n');
    const { app } = realApp();
    const changes = await scanStatus(app, repo);

    const tracked = await fetchDiff(app, repo, changes.find((c) => c.path === 'notes.txt')!);
    expect(tracked).toMatchObject({ ok: true, original: 'one\n', modified: 'one\ntwo\n', isUntracked: false });
    expect(tracked.ok && tracked.unifiedDiff).toContain('+two');
    expect(tracked.ok && tracked.withheld).toBeUndefined();

    const fresh = await fetchDiff(app, repo, changes.find((c) => c.path === 'dir/fresh.txt')!);
    expect(fresh).toEqual({
      ok: true,
      path: 'dir/fresh.txt',
      original: '',
      modified: 'fresh\n',
      unifiedDiff: '',
      isUntracked: true,
      worktreeStamp: expect.stringMatching(/^f:6:\d/),
    });
  });
});

describe('diff symlink guard (fail-closed)', () => {
  const ok = (stdout: string): PluginShellExecResult => ({
    stdout,
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
  });

  it('T5 host scope error on lstat (message-only IPC error): withheld, cat never runs', async () => {
    const exec = vi.fn().mockResolvedValue(ok(SECRET));
    const lstat = vi.fn(async (p: string) => {
      if (p === '/repo/dir') return { size: 0, mtimeMs: 0, isFile: false, isDirectory: true, isSymlink: false };
      throw new Error(
        "Error invoking remote method 'plugin-fs:lstat': ScopeError: path is outside granted scopes",
      );
    });
    const app = { shell: { exec }, fs: { lstat } } as unknown as CoPluginApp;

    const diff = await fetchDiff(app, '/repo', untracked('dir/new.txt'));

    expect(diff).toMatchObject({ ok: true, modified: '', withheld: 'unverified' });
    expect(catCalls(exec)).toEqual([]);
  });

  it('T6 file access unavailable: withheld, cat never runs', async () => {
    const exec = vi.fn().mockResolvedValue(ok(SECRET));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    const diff = await fetchDiff(app, '/repo', untracked('new.txt'));

    expect(diff).toMatchObject({ ok: true, modified: '', withheld: 'unverified' });
    expect(catCalls(exec)).toEqual([]);
  });

  it('T7 explicit ENOENT from lstat is not a link: normal read path', async () => {
    const exec = vi.fn().mockResolvedValue({ ...ok(''), exitCode: 1, stderr: 'cat: gone.txt: No such file' });
    const lstat = vi.fn().mockRejectedValue(
      new Error(
        "Error invoking remote method 'plugin-fs:lstat': Error: ENOENT: no such file or directory, lstat '/repo/gone.txt'",
      ),
    );
    const app = { shell: { exec }, fs: { lstat } } as unknown as CoPluginApp;

    const diff = await fetchDiff(app, '/repo', untracked('gone.txt'));

    expect(diff).toEqual({
      ok: true,
      path: 'gone.txt',
      original: '',
      modified: '',
      unifiedDiff: '',
      isUntracked: true,
      worktreeStamp: 'missing',
    });
  });

  it('T8 paths escaping the repo root (or pointing into the git directory) are never read and no process is spawned for them', async () => {
    const exec = vi.fn().mockResolvedValue(ok(SECRET));
    const lstat = vi.fn().mockResolvedValue({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false });
    const app = { shell: { exec }, fs: { lstat } } as unknown as CoPluginApp;

    for (const path of ['../outside/secret.txt', 'a/../../outside/secret.txt', '/etc/passwd', '.git/config', 'sub/.GIT/config']) {
      const diff = await fetchDiff(app, '/repo', untracked(path));
      expect(diff).toMatchObject({ ok: false, reason: 'git-error', message: expect.stringContaining('not inside this repository') });
      const tracked = await fetchDiff(app, '/repo', { ...untracked(path), status: 'M', statusX: ' ', statusY: 'M' });
      expect(tracked).toMatchObject({ ok: false, reason: 'git-error' });
      const renamed = await fetchDiff(app, '/repo', { path: 'ok.txt', oldPath: path, status: 'R', statusX: 'R', statusY: ' ', kind: 'text' });
      expect(renamed).toMatchObject({ ok: false, reason: 'git-error' });
    }
    expect(exec).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
  });

  it('T8b lstat is asked about the path and every parent below the repo root', async () => {
    const exec = vi.fn().mockResolvedValue(ok('content\n'));
    const lstat = vi.fn().mockResolvedValue({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false });
    const app = { shell: { exec }, fs: { lstat } } as unknown as CoPluginApp;

    const diff = await fetchDiff(app, '/repo/', untracked('a/b/c.txt'));

    expect(lstat.mock.calls.map((c) => c[0]).sort()).toEqual(['/repo/a', '/repo/a/b', '/repo/a/b/c.txt']);
    expect(diff).toMatchObject({ ok: true, modified: 'content\n' });
  });
});

describe('working-tree read: regular files only, file names are never options (real file system)', () => {
  it('T10 tracked file replaced by a FIFO: `cat` would block until the host timeout; the plugin does not run it and withholds the content', async () => {
    rmSync(join(repo, 'notes.txt'));
    execFileSync('mkfifo', [join(repo, 'notes.txt')]);
    // 证明 fixture:cat 这个路径不会自己结束
    const blocked = spawnSync('cat', ['--', 'notes.txt'], { cwd: repo, timeout: 300 });
    expect(blocked.status).toBeNull();

    const { app, exec } = realApp();
    const change: FileChange = { path: 'notes.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' };
    const diff = await fetchDiff(app, repo, change);

    // git 自己拒绝这种文件(unsupported file type),关键是 cat 没有被启动——否则 fetchDiff 要等它超时
    expect(catCalls(exec)).toEqual([]);
    expect(diff).toMatchObject({ ok: false, reason: 'git-error', message: expect.stringContaining('unsupported file type') });
    // 作为未跟踪条目(无 git diff 可依赖)时给出"非普通文件"的说明
    expect(await fetchDiff(app, repo, untracked('notes.txt'))).toMatchObject({ ok: true, modified: '', withheld: 'not-regular' });
    expect(catCalls(exec)).toEqual([]);
  });

  it('T11 an untracked directory entry (`dir/`) is not handed to cat either', async () => {
    mkdirSync(join(repo, 'newdir'));
    writeFileSync(join(repo, 'newdir', 'u.txt'), 'u\n');
    const { app, exec } = realApp();
    const change = (await scanStatus(app, repo)).find((c) => c.path === 'newdir/')!;
    expect(change).toBeTruthy();

    const diff = await fetchDiff(app, repo, change);

    expect(catCalls(exec)).toEqual([]);
    expect(diff).toMatchObject({ ok: true, isUntracked: true, modified: '', withheld: 'not-regular' });
  });

  it('T12 a file named like an option (`-n`, `--help`) is read as a file: cat gets `--` before the path', async () => {
    writeFileSync(join(repo, '-n'), 'dash-n content\n');
    writeFileSync(join(repo, '--help'), 'dash-help content\n');
    // 证明 fixture:不加 `--` 时 cat 把它当选项,读不到文件内容
    expect(spawnSync('cat', ['-n'], { cwd: repo, input: '', encoding: 'utf8' }).stdout).not.toContain('dash-n content');

    const { app, exec } = realApp();
    expect(await fetchDiff(app, repo, untracked('-n'))).toMatchObject({ ok: true, modified: 'dash-n content\n' });
    expect(await fetchDiff(app, repo, untracked('--help'))).toMatchObject({ ok: true, modified: 'dash-help content\n' });
    expect(catCalls(exec).map((c) => c[1])).toEqual([['--', '-n'], ['--', '--help']]);
  });

  it('T13 only an explicit isFile === true is read: a host stat without that field, or any non-file kind, withholds the content', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: SECRET, stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false });
    for (const st of [
      { size: 1, mtimeMs: 0, isFile: false, isDirectory: false, isSymlink: false },
      { size: 1, mtimeMs: 0, isFile: false, isDirectory: true, isSymlink: false },
      { size: 1, mtimeMs: 0, isDirectory: false, isSymlink: false },
    ]) {
      const lstat = vi.fn().mockResolvedValue(st);
      const app = { shell: { exec }, fs: { lstat } } as unknown as CoPluginApp;
      expect(await fetchDiff(app, '/repo', untracked('x.txt'))).toMatchObject({ ok: true, modified: '', withheld: 'not-regular' });
    }
    expect(catCalls(exec)).toEqual([]);

    // 父目录是目录(isFile=false)不影响读取:只对末级要求普通文件
    const lstat = vi.fn(async (p: string) => ({ size: 1, mtimeMs: 0, isFile: p.endsWith('c.txt'), isDirectory: !p.endsWith('c.txt'), isSymlink: false }));
    const app = { shell: { exec }, fs: { lstat } } as unknown as CoPluginApp;
    expect(await fetchDiff(app, '/repo', untracked('a/b/c.txt'))).toMatchObject({ ok: true, modified: SECRET });
  });
});

describe('diff symlink guard (panel)', () => {
  it('T9 shows a notice instead of file content when content was withheld', () => {
    const store = createGitStore();
    const change = untracked('new.txt');
    const { rerender } = render(
      <DiffView
        store={store}
        change={change}
        diff={{ ok: true, path: 'new.txt', original: '', modified: '', unifiedDiff: '', isUntracked: true, withheld: 'symlink' }}
      />,
    );
    expect(screen.getByText('Symbolic link — contents are not shown')).toBeTruthy();
    expect(screen.queryByText('(empty file)')).toBeNull();

    rerender(
      <DiffView
        store={store}
        change={change}
        diff={{ ok: true, path: 'new.txt', original: '', modified: '', unifiedDiff: '', isUntracked: true, withheld: 'unverified' }}
      />,
    );
    expect(
      screen.getByText('Could not verify that this path is not a symbolic link — contents are not shown'),
    ).toBeTruthy();

    rerender(
      <DiffView
        store={store}
        change={change}
        diff={{ ok: true, path: 'new.txt', original: '', modified: '', unifiedDiff: '', isUntracked: true, withheld: 'not-regular' }}
      />,
    );
    expect(screen.getByText('Not a regular file (directory, pipe or device) — contents are not shown')).toBeTruthy();
    expect(screen.queryByText('(empty file)')).toBeNull();
  });
});
