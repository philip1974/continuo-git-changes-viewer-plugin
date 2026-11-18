import { describe, expect, it, vi } from 'vitest';
import { discardFile } from '../../git/discard-file';
import { isPathSafeForPatch } from '../../git/hunk-patch';
import { isForgedIndexPath, isSafeRepoRelativePath, joinRepoPath } from '../../git/path-utils';
import { stageFile } from '../../git/stage-file';
import { unstageFile } from '../../git/unstage-file';
import type { CoPluginApp } from '../../sdk/types';

describe('joinRepoPath', () => {
  it('T1 joins repo root with a relative path', () => {
    expect(joinRepoPath('/repo', 'src/a.ts')).toBe('/repo/src/a.ts');
  });

  it('T2 refuses absolute paths (a path reported by an untrusted repository must not leave the repo root)', () => {
    expect(joinRepoPath('/repo', '/tmp/a.ts')).toBeNull();
    expect(joinRepoPath('/repo/', '/src/a.ts')).toBeNull();
    expect(joinRepoPath('/repo', 'C:\\Users\\x')).toBeNull();
  });

  it('T3 tolerates trailing slash on repo root', () => {
    expect(joinRepoPath('/repo/', 'src/a.ts')).toBe('/repo/src/a.ts');
  });

  it('T4 refuses paths with `..` segments or pointing into the git directory', () => {
    expect(joinRepoPath('/repo', '../outside.txt')).toBeNull();
    expect(joinRepoPath('/repo', 'a/../../outside.txt')).toBeNull();
    expect(joinRepoPath('/repo', '.git/config')).toBeNull();
  });
});

describe('isSafeRepoRelativePath', () => {
  it.each([
    'a.txt',
    'src/deep/a.ts',
    'dir/',
    '[id].tsx',
    '*',
    ':(glob)**',
    ' leading space.txt',
    'name with spaces/ü.txt',
    '.gitignore',
    '.gitmodules',
    '.github/workflows/ci.yml',
    'a..b/c...d',
    '...',
    'git',
    'x.git/y',
    '-n',
  ])('T5 accepts ordinary repo-relative path %j', (path) => {
    expect(isSafeRepoRelativePath(path)).toBe(true);
  });

  it.each([
    '',
    '/',
    '/etc/passwd',
    '\\\\server\\share',
    'C:/Windows/x',
    'c:\\x',
    '..',
    '../outside.txt',
    'a/../../outside.txt',
    'a/..',
    'a\\..\\b',
    './a',
    'a/./b',
    'a//b',
    'a\0b',
    '.git',
    '.git/hooks/pre-commit',
    '.GIT/config',
    '.Git/config',
    'sub/.git/config',
    '.git /config',
    '.git./config',
    '.git. . /config',
    'GIT~1/config',
    '.g\u200cit/config',
    '.git\ufeff/config',
    '.git::$INDEX_ALLOCATION/config',
    'a\\.git\\config',
  ])('T6 rejects %j (absolute, escaping, or resolving into a git directory on some file system)', (path) => {
    expect(isSafeRepoRelativePath(path)).toBe(false);
  });
});

describe('isForgedIndexPath: paths git itself never records in an index', () => {
  it.each(['../outside.txt', 'a/../../b', '/etc/passwd', '.git/hooks/pre-commit', 'sub/.git/config', '.GIT/config', 'git~1/config', '.git‌/config', 'a//b', './a', 'a/./b', '..'])(
    'T8 %j is forged (escapes the repository, is absolute, or lies inside a git directory)',
    (path) => {
      expect(isForgedIndexPath(path)).toBe(true);
      expect(isSafeRepoRelativePath(path)).toBe(false);
    },
  );

  it.each(['a.txt', 'dir/', 'src/a b.ts', '.gitignore', '.github/x.yml', 'a..b', '...', 'c:notes.txt', 'C:\\x', '..\\x', 'a\\.git\\config', '\\\\server\\share'])(
    'T9 %j is not forged — an ordinary name, or one that is only unsafe where `\\` / drive letters mean something (still not shown or operated on)',
    (path) => {
      expect(isForgedIndexPath(path)).toBe(false);
    },
  );
});

describe('every file-level entry point applies the same check', () => {
  it('T7 stage / unstage / discard refuse an unsafe path without spawning git; hunk actions are not offered for it', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false });
    const app = { shell: { exec } } as unknown as CoPluginApp;

    for (const path of ['../outside.txt', '/etc/passwd', '.git/hooks/pre-commit', '.GIT/config']) {
      for (const op of [stageFile, unstageFile, discardFile]) {
        expect(await op(app, '/repo', path)).toEqual({
          ok: false,
          error: expect.stringContaining('not inside this repository'),
        });
      }
      expect(isPathSafeForPatch(path)).toBe(false);
    }
    expect(exec).not.toHaveBeenCalled();
    expect(isPathSafeForPatch('src/a b.ts')).toBe(true);
  });
});

// 宿主按 UTF-8 解码:不是合法 UTF-8 的文件名字节变成 U+FFFD,传回 git 指的是另一个路径
describe('a name containing U+FFFD is not passed back to git', () => {
  it('T8 isSafeRepoRelativePath / joinRepoPath / isPathSafeForPatch refuse it, and stage / unstage / discard refuse without spawning git', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false });
    const app = { shell: { exec } } as unknown as CoPluginApp;
    for (const path of ['caf�', 'dir�/a.txt', 'dir/�']) {
      expect(isSafeRepoRelativePath(path), path).toBe(false);
      expect(joinRepoPath('/repo', path), path).toBeNull();
      expect(isPathSafeForPatch(path), path).toBe(false);
      for (const op of [stageFile, unstageFile, discardFile]) expect((await op(app, '/repo', path)).ok, path).toBe(false);
    }
    expect(exec).not.toHaveBeenCalled();
    // 不是伪造 index 的证据(git 会正常记录这样的名字):只是不可操作
    expect(isForgedIndexPath('caf�')).toBe(false);
    expect(isSafeRepoRelativePath('café/한글.txt')).toBe(true);
  });
});
