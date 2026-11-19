import { describe, expect, it, vi } from 'vitest';
import { probeWorktreeEntry } from '../../git/worktree-entry';
import type { CoPluginApp } from '../../sdk/types';

type Kind = 'file' | 'dir' | 'link' | 'fifo';
const stat = (kind: Kind) => ({ size: 1, mtimeMs: 0, isFile: kind === 'file', isDirectory: kind === 'dir', isSymlink: kind === 'link' });
const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: 'ENOENT' });

// tree:绝对路径 → 类型;不在表里的路径不存在
function fsOf(tree: Record<string, Kind | Error>) {
  const lstat = vi.fn(async (path: string) => {
    const entry = tree[path];
    if (entry === undefined) throw enoent(path);
    if (entry instanceof Error) throw entry;
    return stat(entry);
  });
  return { app: { fs: { lstat } } as unknown as CoPluginApp, lstat };
}

describe('probeWorktreeEntry: what sits at a repository path right now', () => {
  it('W1 reports the type of the path itself without following links: file, symlink, directory, other (FIFO …), missing', async () => {
    const { app } = fsOf({ '/repo/f': 'file', '/repo/l': 'link', '/repo/d': 'dir', '/repo/p': 'fifo' });
    expect(await probeWorktreeEntry(app, '/repo', 'f')).toEqual({ kind: 'file' });
    expect(await probeWorktreeEntry(app, '/repo', 'l')).toEqual({ kind: 'symlink' });
    expect(await probeWorktreeEntry(app, '/repo', 'd')).toEqual({ kind: 'directory' });
    expect(await probeWorktreeEntry(app, '/repo', 'p')).toEqual({ kind: 'other' });
    expect(await probeWorktreeEntry(app, '/repo', 'gone')).toEqual({ kind: 'missing' });
    // 仓库根结尾的分隔符、未跟踪目录写法的结尾 `/` 都不影响
    expect(await probeWorktreeEntry(app, '/repo/', 'd/')).toEqual({ kind: 'directory' });
  });

  it('W2 walks down from the repository root and stops at the first parent that is not a directory: a file or a link where a folder was is reported with its repository path, and nothing below it is looked at', async () => {
    const file = fsOf({ '/repo/a': 'file' });
    expect(await probeWorktreeEntry(file.app, '/repo', 'a/b/c.txt')).toEqual({ kind: 'parent-not-directory', parent: 'a' });
    expect(file.lstat.mock.calls.map(([p]) => p)).toEqual(['/repo/a']);

    const link = fsOf({ '/repo/a': 'dir', '/repo/a/b': 'link' });
    expect(await probeWorktreeEntry(link.app, '/repo', 'a/b/c.txt')).toEqual({ kind: 'parent-not-directory', parent: 'a/b' });
    expect(link.lstat.mock.calls.map(([p]) => p)).toEqual(['/repo/a', '/repo/a/b']);

    const deep = fsOf({ '/repo/a': 'dir', '/repo/a/b': 'dir', '/repo/a/b/c.txt': 'file' });
    expect(await probeWorktreeEntry(deep.app, '/repo', 'a/b/c.txt')).toEqual({ kind: 'file' });
    // 父目录不存在:路径不存在
    expect(await probeWorktreeEntry(deep.app, '/repo', 'a/x/c.txt')).toEqual({ kind: 'missing' });
  });

  it('W3 unknown — never "missing" — when the path cannot be looked at: no file access, an lstat error other than not-found (at any level), or a path that is not a canonical repository path', async () => {
    expect(await probeWorktreeEntry({} as CoPluginApp, '/repo', 'f')).toEqual({ kind: 'unknown' });
    expect(await probeWorktreeEntry({ fs: {} } as unknown as CoPluginApp, '/repo', 'f')).toEqual({ kind: 'unknown' });
    const scope = new Error("Error invoking remote method 'plugin-fs:lstat': ScopeError: path is outside granted scopes");
    expect(await probeWorktreeEntry(fsOf({ '/repo/f': scope }).app, '/repo', 'f')).toEqual({ kind: 'unknown' });
    expect(await probeWorktreeEntry(fsOf({ '/repo/a': scope }).app, '/repo', 'a/f')).toEqual({ kind: 'unknown' });
    const { app, lstat } = fsOf({ '/repo/f': 'file' });
    for (const path of ['../f', '/repo/f', '.git/config', 'a/../f', '']) {
      expect(await probeWorktreeEntry(app, '/repo', path), path).toEqual({ kind: 'unknown' });
    }
    expect(lstat).not.toHaveBeenCalled();
  });

  it('W4 the host loses error codes over IPC: a message starting with ENOENT still means missing', async () => {
    const ipc = new Error("Error invoking remote method 'plugin-fs:lstat': Error: ENOENT: no such file or directory, lstat '/repo/gone'");
    expect(await probeWorktreeEntry(fsOf({ '/repo/gone': ipc }).app, '/repo', 'gone')).toEqual({ kind: 'missing' });
  });
});
