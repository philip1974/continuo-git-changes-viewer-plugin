import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetRestoreCache,
  ancestorUnstageError,
  DIRECTORY_UNSTAGE_ERROR,
  HEAD_DIRECTORY_UNSTAGE_ERROR,
  unstageFile,
  UNVERIFIED_INDEX_ERROR,
} from '../../git/unstage-file';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';
import { buildGitArgs } from '../../git/exec';
import { MAX_ANCESTOR_LEVELS, PATH_TOO_DEEP_ERROR } from '../../git/index-entry';

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

// unstageFile 先问 index:这个路径之下有没有别的条目、祖先是不是条目(`ls-files`,见 T9–T12),再问 HEAD 里它是不是
// 目录(`ls-tree`,T13)。这里一律回答"没有",
// 其余调用原样交给各用例脚本化的 exec——用例对 exec 的断言(第几次调用是什么)不受影响。
function appFor(exec: ReturnType<typeof vi.fn>): CoPluginApp {
  const routed = (cmd: string, args: readonly string[], opts?: unknown) =>
    args.includes('ls-files') || args.includes('ls-tree') ? Promise.resolve(result({})) : exec(cmd, args, opts);
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

  // index 里不能同时有 `x` 与 `x/…`:把 x/a 取回 index 会把已暂存的文件条目 `x` 拿掉(real-git R85);
  // HEAD 里 x 是目录时,撤销 `A  x` 会把 `x/…` 全部取回(real-git R86)
  describe('an entry above the path, or files below it in HEAD, are not changed along with it', () => {
    const OID = '587be6b4c3f93f93c489c0111bba5596147a26cb';
    type Partial_ = Partial<PluginShellExecResult>;
    // index:`ls-files -s -z -- <pathspec>` 按 pathspec 给结果(没列出的 → 空);tree:`ls-tree -z HEAD -- <path>`;
    // head:`rev-parse --quiet --verify HEAD^{commit}`
    function setup(opts: { index?: Record<string, Partial_>; tree?: Partial_; head?: Partial_ } = {}) {
      const exec = vi.fn(async (_cmd: string, args: readonly string[]) => {
        if (args.includes('ls-files')) return result(opts.index?.[args[args.length - 1]!] ?? {});
        if (args.includes('ls-tree')) return result(opts.tree ?? {});
        if (args.includes('rev-parse')) return result(opts.head ?? { stdout: `${OID}\n` });
        return result({});
      });
      const writes = () => exec.mock.calls.filter(([, args]) => args.includes('--staged') || args.includes('reset'));
      return { app: { shell: { exec } } as unknown as CoPluginApp, exec, writes };
    }
    const entry = (path: string, stage = 0) => `100644 ${OID} ${stage}\t${path}\0`;

    it('T11 an ancestor of the path is itself an index entry (`x` staged as a file, the row is `D  x/y/b`) → refused, naming that entry; nothing is written', async () => {
      const { app, writes } = setup({ index: { x: { stdout: entry('x') } } });
      expect(await unstageFile(app, '/repo', 'x/y/b')).toEqual({ ok: false, error: ancestorUnstageError('x') });
      expect(writes()).toEqual([]);
      expect(ancestorUnstageError('x')).toBe(
        '"x" is staged as a file, and this entry belongs to a folder of the same name in the last commit. Unstaging this row would drop "x" from the index as well. Nothing was changed — use git in a terminal.',
      );
      // 任何一级、任何 stage
      const deep = setup({ index: { 'x/y': { stdout: entry('x/y', 2) } } });
      expect(await unstageFile(deep.app, '/repo', 'x/y/b')).toEqual({ ok: false, error: ancestorUnstageError('x/y') });
    });

    it('T12 each ancestor is asked on its own and only the first record is needed: an ancestor that is a folder lists what is below it (however much — the output is capped small and a cut is not a failure) and does not block; a query that fails or times out, or a first record that is cut or unreadable, refuses (fail-closed); a path at the top level has no ancestor and asks nothing', async () => {
      const folder = setup({ index: { x: { stdout: entry('x/a') + entry('x/y/b').slice(0, 20), truncated: true }, 'x/y': { stdout: entry('x/y/b') } } });
      expect(await unstageFile(folder.app, '/repo', 'x/y/b')).toEqual({ ok: true });
      expect(folder.writes()).toHaveLength(1);
      for (const ancestor of ['x', 'x/y']) {
        expect(folder.exec).toHaveBeenCalledWith(
          'git',
          buildGitArgs(['ls-files', '-s', '-z', '--', ancestor]),
          expect.objectContaining({ cwd: '/repo', maxOutputBytes: 64 * 1024, env: expect.objectContaining({ GIT_LITERAL_PATHSPECS: '1' }) }),
        );
      }

      for (const failed of [{ exitCode: 128, stderr: 'fatal' }, { exitCode: null, timedOut: true }, { stdout: `100644 ${OID} 0\tx`, truncated: true }, { stdout: 'garbage\0' }]) {
        _resetRestoreCache();
        const { app, writes } = setup({ index: { x: failed } });
        expect(await unstageFile(app, '/repo', 'x/a'), JSON.stringify(failed)).toEqual({ ok: false, error: UNVERIFIED_INDEX_ERROR });
        expect(writes()).toEqual([]);
      }
      // 一级查不了、另一级确实是条目:说得出原因就说原因
      const mixed = setup({ index: { x: { exitCode: 128 }, 'x/y': { stdout: entry('x/y') } } });
      expect(await unstageFile(mixed.app, '/repo', 'x/y/b')).toEqual({ ok: false, error: ancestorUnstageError('x/y') });

      _resetRestoreCache();
      const top = setup();
      expect(await unstageFile(top.app, '/repo', 'a.ts')).toEqual({ ok: true });
      expect(top.exec.mock.calls.filter(([, args]) => args.includes('ls-files'))).toHaveLength(1);
    });

    it('T13 the path is a folder in HEAD (the row is `A  x`: a file staged where a folder was) → refused: unstaging would bring every `x/…` entry back from HEAD; a file, a submodule or nothing in HEAD does not block; no commit yet → nothing to bring back; a query that cannot be answered refuses', async () => {
      const dir = setup({ tree: { stdout: `040000 tree ${OID}\tx\0` } });
      expect(await unstageFile(dir.app, '/repo', 'x')).toEqual({ ok: false, error: HEAD_DIRECTORY_UNSTAGE_ERROR });
      expect(dir.writes()).toEqual([]);
      expect(dir.exec).toHaveBeenCalledWith('git', buildGitArgs(['ls-tree', '-z', 'HEAD', '--', 'x']), expect.objectContaining({ cwd: '/repo' }));
      expect(HEAD_DIRECTORY_UNSTAGE_ERROR).toBe(
        'In the last commit this path is a folder. Unstaging this row would also unstage the deletions staged for the files in it. Nothing was changed — use git in a terminal.',
      );

      for (const stdout of [`100644 blob ${OID}\tx\0`, `160000 commit ${OID}\tx\0`, '']) {
        _resetRestoreCache();
        const ok = setup({ tree: { stdout } });
        expect(await unstageFile(ok.app, '/repo', 'x'), JSON.stringify(stdout)).toEqual({ ok: true });
        expect(ok.writes()).toHaveLength(1);
      }

      // ls-tree 失败:只有"还没有提交"(rev-parse --quiet --verify 以 1 退出)才照常
      _resetRestoreCache();
      const unborn = setup({ tree: { exitCode: 128, stderr: 'fatal: Not a valid object name HEAD' }, head: { exitCode: 1 } });
      expect(await unstageFile(unborn.app, '/repo', 'x')).toEqual({ ok: true });
      expect(unborn.exec).toHaveBeenCalledWith('git', buildGitArgs(['rev-parse', '--quiet', '--verify', 'HEAD^{commit}']), expect.objectContaining({ cwd: '/repo' }));

      const unknown: Array<{ tree: Partial_; head?: Partial_ }> = [
        { tree: { exitCode: 128 }, head: { exitCode: 0, stdout: `${OID}\n` } },
        { tree: { exitCode: 128 }, head: { exitCode: 128 } },
        { tree: { exitCode: 128 }, head: { exitCode: 1, timedOut: true } },
        { tree: { exitCode: null, timedOut: true }, head: { exitCode: 1 } },
        { tree: { stdout: `100644 blob ${OID}\tx`, truncated: true }, head: { exitCode: 0 } },
      ];
      for (const opts of unknown) {
        _resetRestoreCache();
        const { app, writes } = setup(opts);
        expect(await unstageFile(app, '/repo', 'x'), JSON.stringify(opts)).toEqual({ ok: false, error: UNVERIFIED_INDEX_ERROR });
        expect(writes()).toEqual([]);
      }
    });
  });

  // 宿主每个窗口最多 32 个并发 exec,超出直接 reject:此前每一级祖先并行一条 `ls-files`,路径深 ≥ 34 级时
  // Unstage / Stage 静默失效(未处理的 rejection),同窗口其它调用一起被拒(复核者实测)。
  describe('the ancestors are asked one at a time, with a depth limit', () => {
    const OID = '587be6b4c3f93f93c489c0111bba5596147a26cb';
    const deepPath = (levels: number) => [...Array.from({ length: levels }, (_, i) => `d${i}`), 'f'].join('/');
    function setup(index: Record<string, Partial<PluginShellExecResult>> = {}) {
      let active = 0;
      const stat = { peak: 0 };
      const exec = vi.fn(async (_cmd: string, args: readonly string[]) => {
        active += 1;
        stat.peak = Math.max(stat.peak, active);
        await new Promise((r) => setTimeout(r, 0));
        active -= 1;
        if (args.includes('ls-files')) return result(index[args[args.length - 1]!] ?? {});
        return result({});
      });
      const ancestorQueries = () =>
        exec.mock.calls.map(([, args]) => args as readonly string[]).filter((args) => args.includes('ls-files')).map((args) => args[args.length - 1]);
      const writes = () => exec.mock.calls.filter(([, args]) => args.includes('--staged') || args.includes('reset'));
      return { app: { shell: { exec } } as unknown as CoPluginApp, exec, stat, ancestorQueries, writes };
    }

    it('T14 a path 40 levels deep: never more than one git process at a time; every ancestor is asked, shallow to deep; the unstage goes through', async () => {
      const path = deepPath(40);
      const { app, stat, ancestorQueries, writes } = setup();
      expect(await unstageFile(app, '/repo', path)).toEqual({ ok: true });
      expect(stat.peak).toBe(1);
      const levels = path.split('/');
      // 第一条是 hasIndexEntriesInside(路径自己),其后是各级祖先,从浅到深
      expect(ancestorQueries()).toEqual([path, ...levels.slice(0, -1).map((_, i) => levels.slice(0, i + 1).join('/'))]);
      expect(writes()).toHaveLength(1);
    });

    it('T15 the first ancestor found to be an entry stops the search: deeper ancestors are not asked', async () => {
      const { app, ancestorQueries, writes } = setup({ 'd0/d1': { stdout: `100644 ${OID} 0\td0/d1\0` } });
      expect(await unstageFile(app, '/repo', deepPath(6))).toEqual({ ok: false, error: ancestorUnstageError('d0/d1') });
      expect(ancestorQueries().slice(1)).toEqual(['d0', 'd0/d1']);
      expect(writes()).toEqual([]);
    });

    it(`T16 more than ${64} ancestors: refused before any ancestor is asked, with its own message; exactly ${64} is still checked`, async () => {
      expect(MAX_ANCESTOR_LEVELS).toBe(64);
      const tooDeep = setup();
      expect(await unstageFile(tooDeep.app, '/repo', deepPath(65))).toEqual({ ok: false, error: PATH_TOO_DEEP_ERROR });
      expect(tooDeep.exec).not.toHaveBeenCalled();
      expect(PATH_TOO_DEEP_ERROR).toBe(
        'This path is nested more than 64 folders deep — too deep to check the index for an entry above it. Nothing was changed — use git in a terminal.',
      );
      const limit = setup();
      expect(await unstageFile(limit.app, '/repo', deepPath(64))).toEqual({ ok: true });
      expect(limit.ancestorQueries()).toHaveLength(65);
    });
  });
});
