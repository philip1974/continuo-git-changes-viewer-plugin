import { describe, expect, it, vi } from 'vitest';
import {
  parsePorcelainStatus,
  scanStatus,
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
});
