import { describe, expect, it, vi } from 'vitest';
import { readStatusHash } from '../../git/status-hash';
import { scanStatus } from '../../git/status-scanner';
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
      'git status failed (fatal: not a repo)',
    );
  });

  it('T6d the fingerprint read has the same time limit as the list read (none of its own: the host default) — it used to give up after 5 s, and in a repository where status takes longer the list loaded while the fingerprint never did; a timeout or a cut output is an error with its reason, never a fingerprint', async () => {
    const exec = vi.fn().mockResolvedValue(result({ stdout: 'fp' }));
    const app = { shell: { exec } } as unknown as CoPluginApp;
    await readStatusHash(app, '/repo');
    await scanStatus(app, '/repo');
    const [fingerprintCall, listCall] = exec.mock.calls.filter(([, args]) => (args as string[]).includes('status'));
    expect((fingerprintCall![2] as { timeoutMs?: number }).timeoutMs).toBeUndefined();
    expect((fingerprintCall![2] as { timeoutMs?: number }).timeoutMs).toBe((listCall![2] as { timeoutMs?: number }).timeoutMs);

    exec.mockResolvedValue(result({ exitCode: null, signal: 'SIGTERM', timedOut: true, stdout: '# branch.oid 12' }));
    await expect(readStatusHash(app, '/repo')).rejects.toThrow('git status failed (timed out)');
    // 被截断的输出不能当指纹:截断点之后的变化比较不出来
    exec.mockResolvedValue(result({ stdout: '# branch.oid 1234\x001 A. N...', truncated: true }));
    await expect(readStatusHash(app, '/repo')).rejects.toThrow('git status output was too large');
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
