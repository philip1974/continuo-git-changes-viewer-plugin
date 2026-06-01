import { describe, expect, it, vi } from 'vitest';
import {
  parsePorcelainStatus,
  scanStatus,
  type FileChange,
} from '../../git/status-scanner';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';

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
      ['--no-optional-locks', 'status', '--porcelain=v1', '-z'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });
});
