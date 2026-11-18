import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetRestoreCache, unstageFile } from '../../git/unstage-file';
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

beforeEach(() => _resetRestoreCache());

describe('unstageFile shell wrapper', () => {
  it('T5 uses git restore --staged when restore support is detected', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(unstageFile(app, '/repo', 'a.ts')).resolves.toEqual({ ok: true });

    expect(exec).toHaveBeenNthCalledWith(1, 'git', buildGitArgs(['restore', '-h']), {
      cwd: '/repo',
      env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
      timeoutMs: 5_000,
    });
    expect(exec).toHaveBeenNthCalledWith(2, 'git', buildGitArgs(['restore', '--staged', '--', 'a.ts']), {
      cwd: '/repo',
      env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
      timeoutMs: 10_000,
    });
  });

  it('T5b `git restore -h` exits 129 (usage) on git before 2.5x and 0 on newer ones: both mean the command exists → restore --staged is used', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 129, stdout: 'usage: git restore [<options>] [--source=<branch>] <file>...\n' }))
      .mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(unstageFile(app, '/repo', 'a.ts')).resolves.toEqual({ ok: true });
    await unstageFile(app, '/repo', 'b.ts');

    expect(exec.mock.calls.map((call) => (call[1] as string[]).slice((call[1] as string[]).indexOf('restore')))).toEqual([
      ['restore', '-h'],
      ['restore', '--staged', '--', 'a.ts'],
      ['restore', '--staged', '--', 'b.ts'],
    ]);
  });

  it.each([
    ['a timeout', result({ exitCode: null, timedOut: true })],
    ['a signal', result({ exitCode: null, signal: 'SIGKILL' })],
    ['a refusal by the repository guard (128)', result({ exitCode: 128, stderr: 'Git commands are disabled for this repository: x' })],
  ])('T6b the probe ending in %s is not taken as support: the reset fallback is used', async (_label, probe) => {
    const exec = vi.fn().mockResolvedValueOnce(probe).mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;
    await unstageFile(app, '/repo', 'a.ts');
    expect(exec).toHaveBeenLastCalledWith('git', buildGitArgs(['reset', 'HEAD', '--', 'a.ts']), expect.anything());
  });

  const probes = (exec: ReturnType<typeof vi.fn>) => exec.mock.calls.filter((call) => (call[1] as string[]).includes('-h')).length;
  const lastSub = (exec: ReturnType<typeof vi.fn>) => {
    const args = exec.mock.calls[exec.mock.calls.length - 1]![1] as string[];
    return args.slice(args.findIndex((a) => a === 'restore' || a === 'reset'));
  };

  it.each([
    ['a timeout', result({ exitCode: null, timedOut: true })],
    ['a timeout that still reports exit 1', result({ exitCode: 1, timedOut: true })],
    ['a signal', result({ exitCode: null, signal: 'SIGKILL' })],
    ['a refusal by the repository guard (128)', result({ exitCode: 128, stderr: 'Git commands are disabled for this repository: x' })],
    ['an unexpected exit code', result({ exitCode: 2 })],
  ])('T6c the probe ending in %s says nothing about git: it is not cached — this call uses the reset fallback, the next call probes again and, once the probe answers, restore is used and remembered', async (_label, probe) => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(probe) // 探测:无结论
      .mockResolvedValueOnce(result({ exitCode: 0 })) // reset 兜底
      .mockResolvedValueOnce(result({ exitCode: 129 })) // 再次探测:支持
      .mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await unstageFile(app, '/repo', 'a.ts');
    expect(lastSub(exec)).toEqual(['reset', 'HEAD', '--', 'a.ts']);
    expect(probes(exec)).toBe(1);

    await unstageFile(app, '/repo', 'b.ts');
    expect(probes(exec)).toBe(2);
    expect(lastSub(exec)).toEqual(['restore', '--staged', '--', 'b.ts']);

    await unstageFile(app, '/repo', 'c.ts');
    expect(probes(exec)).toBe(2);
    expect(lastSub(exec)).toEqual(['restore', '--staged', '--', 'c.ts']);
  });

  it('T6d "no such command" (exit 1, the only definite negative) is cached: later calls go straight to reset without probing again', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: "git: 'restore' is not a git command. See 'git --help'." }))
      .mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await unstageFile(app, '/repo', 'a.ts');
    await unstageFile(app, '/repo', 'b.ts');
    expect(probes(exec)).toBe(1);
    expect(lastSub(exec)).toEqual(['reset', 'HEAD', '--', 'b.ts']);
  });

  it('T6 uses git reset HEAD when restore support is unavailable', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: 'unknown command: restore' }))
      .mockResolvedValueOnce(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await expect(unstageFile(app, '/repo', 'a.ts')).resolves.toEqual({ ok: true });

    expect(exec).toHaveBeenNthCalledWith(2, 'git', buildGitArgs(['reset', 'HEAD', '--', 'a.ts']), {
      cwd: '/repo',
      env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
      timeoutMs: 10_000,
    });
  });

  it('T7 caches restore support across calls', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await unstageFile(app, '/repo', 'a.ts');
    await unstageFile(app, '/repo', 'b.ts');

    expect(exec.mock.calls.filter((call) => (call[1] as string[]).includes('-h'))).toHaveLength(1);
    expect(exec).toHaveBeenLastCalledWith('git', buildGitArgs(['restore', '--staged', '--', 'b.ts']), expect.anything());
  });

  it('T8 reset helper clears the restore capability cache', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: 'unknown command: restore' }))
      .mockResolvedValueOnce(result({ exitCode: 0 }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await unstageFile(app, '/repo', 'a.ts');
    _resetRestoreCache();
    await unstageFile(app, '/repo', 'b.ts');

    expect(exec.mock.calls.filter((call) => (call[1] as string[]).includes('-h'))).toHaveLength(2);
    expect(exec).toHaveBeenLastCalledWith('git', buildGitArgs(['reset', 'HEAD', '--', 'b.ts']), expect.anything());
  });
});
