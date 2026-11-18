import { describe, expect, it, vi } from 'vitest';
import { readStatusHash } from '../../git/status-hash';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';
import { buildGitArgs } from '../../git/exec';

function result(overrides: Partial<PluginShellExecResult>): PluginShellExecResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

describe('readStatusHash', () => {
  it('T6 returns raw porcelain v2 stdout (it carries the HEAD / index object ids of every entry) through the read-only git wrapper', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue(result({ stdout: '1 .M N... 100644 100644 100644 aaa aaa src/a.ts\0? notes.txt\0' }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(readStatusHash(app, '/repo')).resolves.toBe(
      '1 .M N... 100644 100644 100644 aaa aaa src/a.ts\0? notes.txt\0',
    );
    expect(exec).toHaveBeenCalledWith(
      'git',
      buildGitArgs(['status', '--porcelain=v2', '--branch', '--no-ahead-behind', '-z']),
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
      }),
    );
  });

  it('T6b throws on non-zero git status', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue(result({ exitCode: 128, stderr: 'fatal: not a repo' }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(readStatusHash(app, '/repo')).rejects.toThrow(
      'git status failed: fatal: not a repo',
    );
  });
  it('T6c the command asks for the branch header (HEAD commit and branch name are part of the fingerprint) without counting ahead / behind, and the output is returned untouched — header records included', async () => {
    const stdout = '# branch.oid 1234abcd\0# branch.head main\x001 A. N... 000000 100644 100644 0000 8ba3 f\0';
    const exec = vi.fn().mockResolvedValue(result({ stdout }));
    const app = { shell: { exec } } as unknown as CoPluginApp;
    await expect(readStatusHash(app, '/repo')).resolves.toBe(stdout);
    const args = exec.mock.calls[0]![1] as string[];
    expect(args).toContain('--branch');
    expect(args).toContain('--no-ahead-behind');
    // 固定的加固参数照旧(子模块不进入、不取可选锁)
    expect(args).toContain('--ignore-submodules=dirty');
    expect(args).toContain('--no-optional-locks');
  });
});
