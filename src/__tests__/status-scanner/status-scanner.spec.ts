import { describe, expect, it, vi } from 'vitest';
import {
  parsePorcelainStatus,
  scanStatus,
  UnsafeIndexError,
  type FileChange,
} from '../../git/status-scanner';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';
import { buildGitArgs } from '../../git/exec';

function result(stdout: string): PluginShellExecResult {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
  };
}

describe('porcelain status parsing', () => {
  it('T1 maps M/A/D/U records and splits changed vs untracked paths', () => {
    const parsed = parsePorcelainStatus(
      ' M src/changed.ts\0A  src/new.ts\0 D src/deleted.ts\0?? notes.txt\0',
    );

    expect(parsed).toEqual<FileChange[]>([
      { path: 'src/changed.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
      { path: 'src/new.ts', status: 'A', statusX: 'A', statusY: ' ', kind: 'text' },
      { path: 'src/deleted.ts', status: 'D', statusX: ' ', statusY: 'D', kind: 'text' },
      { path: 'notes.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' },
    ]);
  });

  it('T2 maps rename records with oldPath and current path', () => {
    const parsed = parsePorcelainStatus('R  src/new.ts\0src/old.ts\0');

    expect(parsed).toEqual<FileChange[]>([
      {
        path: 'src/new.ts',
        oldPath: 'src/old.ts',
        status: 'R',
        statusX: 'R',
        statusY: ' ',
        kind: 'text',
      },
    ]);
  });

  it('T5 copy records (status.renames=copies) also carry an original path: it is consumed, never turned into an entry of its own', () => {
    const parsed = parsePorcelainStatus('C  copy.txt\0/etc/passwd\0 M a.txt\0CM c2.txt\0src.txt\0 C wt-copy.txt\0a.txt\0');

    expect(parsed).toEqual<FileChange[]>([
      { path: 'a.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
      { path: 'c2.txt', status: 'A', statusX: 'C', statusY: 'M', kind: 'text' },
      { path: 'wt-copy.txt', status: 'A', statusX: ' ', statusY: 'C', kind: 'text' },
    ]);
    // 原路径合法时:复制按新增显示,不带 oldPath(原文件仍在)
    expect(parsePorcelainStatus('C  copy.txt\0a.txt\0')).toEqual<FileChange[]>([
      { path: 'copy.txt', status: 'A', statusX: 'C', statusY: ' ', kind: 'text' },
    ]);
  });

  it('T6 entries whose path (or rename source) is absolute, escapes the repository or points into a git directory are dropped', () => {
    const parsed = parsePorcelainStatus(
      [
        'AM ../outside.txt',
        'AM /etc/passwd',
        'AD .git/hooks/pre-commit',
        ' M .GIT/config',
        ' M a/../../b',
        'R  ok-new.txt', '../old-outside.txt',
        'R  .git/x', 'ok-old.txt',
        ' M fine.txt',
        '?? dir/',
        'R  new.txt', 'old.txt',
      ].join('\0') + '\0',
    );

    expect(parsed.map((c) => [c.path, c.oldPath])).toEqual([
      ['fine.txt', undefined],
      ['dir/', undefined],
      ['new.txt', 'old.txt'],
    ]);
  });

  it('T3 marks binary files from numstat map', () => {
    const parsed = parsePorcelainStatus(' M image.png\0', new Map([
      ['image.png', { isBinary: true, add: null, del: null }],
    ]));

    expect(parsed[0]?.kind).toBe('binary');
  });

  it('T4 scans status through read-only git wrapper and enriches binary kind', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result(' M image.png\0?? notes.txt\0'))
      .mockResolvedValueOnce(result('-\t-\timage.png\0'));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(scanStatus(app, '/repo')).resolves.toEqual([
      { path: 'image.png', status: 'M', statusX: ' ', statusY: 'M', kind: 'binary' },
      { path: 'notes.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' },
    ]);
    expect(exec).toHaveBeenNthCalledWith(
      1,
      'git',
      buildGitArgs(['status', '--porcelain=v1', '-z']),
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it.each([
    ['a staged entry outside the repository', 'A  ../outside.txt\0 M ok.txt\0', ['../outside.txt']],
    ['entries inside the git directory and an absolute path', 'AD .git/hooks/pre-commit\0AM /etc/passwd\0 M .GIT/config\0', ['.git/hooks/pre-commit', '/etc/passwd', '.GIT/config']],
    ['a rename whose source is forged', 'R  ok-new.txt\0../old-outside.txt\0', ['../old-outside.txt']],
    ['a rename whose target is forged', 'R  .git/x\0ok-old.txt\0', ['.git/x']],
  ])('T7 %s → scanStatus rejects with UnsafeIndexError naming the paths (git never records them, and a commit would write them into the tree unseen); numstat is not run', async (_label, stdout, paths) => {
    const exec = vi.fn().mockResolvedValueOnce(result(stdout)).mockResolvedValue(result(''));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    const error = await scanStatus(app, '/repo').then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeIndexError);
    expect((error as UnsafeIndexError).paths).toEqual(paths);
    expect((error as UnsafeIndexError).message).toContain(paths[0]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  // POSIX 上合法、但不满足 isSafeRepoRelativePath 的名字(盘符形、含 `\`、`..\x`、`.git\x`):git 自己会记录它们,
  // 不是伪造的证据;插件不为它们运行任何命令。它们若已暂存,`commit` 照样提交——所以必须留在列表里让用户看见。
  it('T8 names the plugin will not pass to git but git itself records (`c:notes.txt`, `..\\x`, `.git\\config`, `\\x`) stay in the list as inoperable rows, in whatever state they are — staged ones included; the scan does not fail', async () => {
    const stdout = 'A  c:notes.txt\0AM ..\\x\0 M .git\\config\0?? \\x\0M  a:b\0 M ok.txt\0?? a\\b\0';
    const exec = vi.fn().mockResolvedValueOnce(result(stdout)).mockResolvedValue(result(''));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    expect(await scanStatus(app, '/repo')).toEqual<FileChange[]>([
      { path: 'c:notes.txt', status: 'A', statusX: 'A', statusY: ' ', kind: 'text', inoperable: true },
      { path: '..\\x', status: 'A', statusX: 'A', statusY: 'M', kind: 'text', inoperable: true },
      { path: '.git\\config', status: 'M', statusX: ' ', statusY: 'M', kind: 'text', inoperable: true },
      { path: '\\x', status: 'U', statusX: '?', statusY: '?', kind: 'text', inoperable: true },
      { path: 'a:b', status: 'M', statusX: 'M', statusY: ' ', kind: 'text', inoperable: true },
      { path: 'ok.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
      // `a\b` 两段都是普通名字:可操作
      { path: 'a\\b', status: 'U', statusX: '?', statusY: '?', kind: 'text' },
    ]);
  });

  it('T9 a rename / copy whose other side is such a name is one inoperable row (the original path is still consumed and shown as text); forged paths are still dropped by the parser, and still fail the scan even next to inoperable ones', async () => {
    expect(parsePorcelainStatus('R  new.txt\0c:old.txt\0R  d:new.txt\0old.txt\0C  copy.txt\0..\\src\0 M ok.txt\0')).toEqual<FileChange[]>([
      { path: 'new.txt', oldPath: 'c:old.txt', status: 'R', statusX: 'R', statusY: ' ', kind: 'text', inoperable: true },
      { path: 'd:new.txt', oldPath: 'old.txt', status: 'R', statusX: 'R', statusY: ' ', kind: 'text', inoperable: true },
      { path: 'copy.txt', status: 'A', statusX: 'C', statusY: ' ', kind: 'text', inoperable: true },
      { path: 'ok.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
    ]);
    expect(parsePorcelainStatus('A  ../outside\0A  c:notes.txt\0R  ok.txt\0/abs\0').map((c) => c.path)).toEqual(['c:notes.txt']);

    const exec = vi.fn().mockResolvedValueOnce(result('A  c:notes.txt\0A  ../outside\0')).mockResolvedValue(result(''));
    const error = await scanStatus({ shell: { exec } } as unknown as CoPluginApp, '/repo').then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeIndexError);
    expect((error as UnsafeIndexError).paths).toEqual(['../outside']);
  });
});
