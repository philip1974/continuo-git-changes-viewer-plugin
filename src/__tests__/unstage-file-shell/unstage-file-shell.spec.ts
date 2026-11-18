import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetRestoreCache, DIRECTORY_UNSTAGE_ERROR, unstageFile, UNVERIFIED_INDEX_ERROR } from '../../git/unstage-file';
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

// unstageFile 先问 index:这个路径之下有没有别的条目(`ls-files`,见 T9–T10)。这里一律回答"没有",
// 其余调用原样交给各用例脚本化的 exec——用例对 exec 的断言(第几次调用是什么)不受影响。
function appFor(exec: ReturnType<typeof vi.fn>): CoPluginApp {
  const routed = (cmd: string, args: readonly string[], opts?: unknown) =>
    args.includes('ls-files') ? Promise.resolve(result({})) : exec(cmd, args, opts);
  return { shell: { exec: routed } } as unknown as CoPluginApp;
}

describe('unstageFile shell wrapper', () => {
  it('T5 uses git restore --staged when restore support is detected', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }));
    const app = appFor(exec);

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
    const app = appFor(exec);

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
    const app = appFor(exec);
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
    const app = appFor(exec);

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
    const app = appFor(exec);

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
    const app = appFor(exec);

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
    const app = appFor(exec);

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
    const app = appFor(exec);

    await unstageFile(app, '/repo', 'a.ts');
    _resetRestoreCache();
    await unstageFile(app, '/repo', 'b.ts');

    expect(exec.mock.calls.filter((call) => (call[1] as string[]).includes('-h'))).toHaveLength(2);
    expect(exec).toHaveBeenLastCalledWith('git', buildGitArgs(['reset', 'HEAD', '--', 'b.ts']), expect.anything());
  });
  // `git restore --staged -- x` / `git reset HEAD -- x` 把 x 当前缀:`x/…` 的暂存条目一并被撤销(real-git R79)
  describe('other staged entries below the path are not unstaged along with it', () => {
    const OID = '587be6b4c3f93f93c489c0111bba5596147a26cb';
    function setup(lsFiles: Partial<PluginShellExecResult>) {
      const exec = vi.fn(async (_cmd: string, args: readonly string[]) => result(args.includes('ls-files') ? lsFiles : {}));
      const writes = () => exec.mock.calls.filter(([, args]) => args.includes('--staged') || args.includes('reset'));
      return { app: { shell: { exec } } as unknown as CoPluginApp, exec, writes };
    }

    it('T9 the index has entries inside `<path>/` → refused with an explanation, before anything else is run; the query is read-only and names the path literally', async () => {
      const { app, exec, writes } = setup({ stdout: `100644 ${OID} 0\tx/work.txt\0` });
      expect(await unstageFile(app, '/repo', 'x')).toEqual({ ok: false, error: DIRECTORY_UNSTAGE_ERROR });
      expect(writes()).toEqual([]);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith('git', buildGitArgs(['ls-files', '-s', '-z', '--', 'x']), expect.objectContaining({ cwd: '/repo' }));
      expect(DIRECTORY_UNSTAGE_ERROR).toBe(
        'Other staged entries sit inside a directory of this name. Unstaging this row would unstage them too. Nothing was changed — unstage those entries first, or use git in a terminal.',
      );
      // 未合并的各 stage 同样算
      const conflict = setup({ stdout: `100644 ${OID} 0\tx\x00100644 ${OID} 2\tx/a\0` });
      expect(await unstageFile(conflict.app, '/repo', 'x')).toEqual({ ok: false, error: DIRECTORY_UNSTAGE_ERROR });
    });

    it('T10 only entries below the path count: its own record, no record (a staged deletion), and names that merely start with the same letters do not block; a query that fails, times out or is cut short refuses (fail-closed)', async () => {
      for (const stdout of [`100644 ${OID} 0\tx\0`, '', `100644 ${OID} 0\tx.txt\x00100644 ${OID} 0\txy/a\0`]) {
        _resetRestoreCache();
        const { app, writes } = setup({ stdout });
        expect(await unstageFile(app, '/repo', 'x'), JSON.stringify(stdout)).toEqual({ ok: true });
        expect(writes()).toHaveLength(1);
      }
      for (const lsFiles of [{ exitCode: 128, stderr: 'fatal' }, { exitCode: null, timedOut: true }, { stdout: `100644 ${OID} 0\tx/wo`, truncated: true }]) {
        const { app, writes } = setup(lsFiles);
        expect(await unstageFile(app, '/repo', 'x')).toEqual({ ok: false, error: UNVERIFIED_INDEX_ERROR });
        expect(writes()).toEqual([]);
      }
    });
  });
});
