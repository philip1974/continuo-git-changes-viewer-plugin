import { describe, expect, it, vi } from 'vitest';
import { loadNumstat, parseNumstat } from '../../git/numstat';
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

describe('numstat parsing', () => {
  it('T1 parses text additions and deletions', () => {
    const parsed = parseNumstat('3\t1\tsrc/a.ts\0');

    expect(parsed.get('src/a.ts')).toEqual({
      isBinary: false,
      add: 3,
      del: 1,
    });
  });

  it('T2 marks binary records from dash dash fields', () => {
    const parsed = parseNumstat('-\t-\tassets/logo.png\0');

    expect(parsed.get('assets/logo.png')).toEqual({
      isBinary: true,
      add: null,
      del: null,
    });
  });

  it('T3 ignores empty trailing NUL records', () => {
    const parsed = parseNumstat('1\t0\ta.txt\0\0');

    expect([...parsed.keys()]).toEqual(['a.txt']);
  });

  it('T4 loads numstat through gitExec', async () => {
    const exec = vi.fn().mockResolvedValue(result('1\t0\ta.txt\0'));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    const parsed = await loadNumstat(app, '/repo');

    expect(parsed.get('a.txt')?.isBinary).toBe(false);
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'diff', '--numstat', '-z', 'HEAD'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });
});
