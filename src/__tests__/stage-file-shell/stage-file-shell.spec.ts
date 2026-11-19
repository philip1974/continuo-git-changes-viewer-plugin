import { describe, expect, it, vi } from 'vitest';
import { ancestorStageError, DIRECTORY_STAGE_ERROR, stageFile, UNVERIFIED_STAGE_ERROR } from '../../git/stage-file';
import { PATH_TOO_DEEP_ERROR } from '../../git/index-entry';
import { UNVERIFIED_PATH_ERROR } from '../../git/worktree-entry';
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

// stageFile 先看工作树里这个位置现在是什么(app.fs.lstat,见 T6–T8):这里一律是普通文件
const FILE_FS = { lstat: async () => ({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false }) };

describe('stageFile shell wrapper', () => {
  it('T1 runs git add through shell.exec with no optional locks', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec }, fs: FILE_FS } as unknown as CoPluginApp;

    await expect(stageFile(app, '/repo', 'new.txt')).resolves.toEqual({ ok: true });

    expect(exec).toHaveBeenCalledWith('git', buildGitArgs(['add', '--', 'new.txt']), {
      cwd: '/repo',
      env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
      timeoutMs: 10_000,
    });
  });

  it('T2 maps git add failures to error results', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 1, stderr: 'add failed' }));
    const app = { shell: { exec }, fs: FILE_FS } as unknown as CoPluginApp;

    await expect(stageFile(app, '/repo', 'bad.txt')).resolves.toEqual({
      ok: false,
      error: 'add failed',
    });
  });

  it('T3 always uses -- before the file path', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec }, fs: FILE_FS } as unknown as CoPluginApp;

    await stageFile(app, '/repo', '--looks-like-option');

    expect(exec.mock.calls[0]?.[1]).toEqual(buildGitArgs(['add', '--', '--looks-like-option']));
  });

  it('T4 falls back to an exit-code message when stderr is empty', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 128 }));
    const app = { shell: { exec }, fs: FILE_FS } as unknown as CoPluginApp;

    await expect(stageFile(app, '/repo', 'a.ts')).resolves.toEqual({
      ok: false,
      error: 'git add exit 128',
    });
  });

  it('T5 an untracked path is added with the repository\'s own core.precomposeUnicode (its name was read from the directory under that setting); a tracked path pins it to false', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec }, fs: FILE_FS } as unknown as CoPluginApp;
    const pin = 'core.precomposeUnicode=false';

    await stageFile(app, '/repo', 'caf\u00e9.txt', { untracked: true });
    expect(exec.mock.calls[0]?.[1]).toEqual(buildGitArgs(['add', '--', 'caf\u00e9.txt'], { untrackedPathArgs: true }));
    expect(exec.mock.calls[0]?.[1]).not.toContain(pin);

    await stageFile(app, '/repo', 'cafe\u0301.txt');
    await stageFile(app, '/repo', 'cafe\u0301.txt', { untracked: false });
    expect(exec.mock.calls[1]?.[1]).toContain(pin);
    expect(exec.mock.calls[2]?.[1]).toContain(pin);
  });
  // `git add -- x` 在 x 的位置上是普通目录时,把目录里所有未跟踪的文件一并加入(real-git R78)
  describe('a tracked row is not staged as a directory', () => {
    const FILE = { size: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false };
    const DIR = { ...FILE, isFile: false, isDirectory: true };
    const FILE_ENTRY = '100644 587be6b4c3f93f93c489c0111bba5596147a26cb 0\tx\0';
    const enoent = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    // tree:绝对路径 → stat;不在表里的不存在。lsFiles:`ls-files -s -z -- <path>` 的输出(index 里的记录);
    // untracked:`ls-files -o --exclude-standard -z -- <path>` 的结果(git add 会加入的未跟踪条目)
    function setup(tree: Record<string, typeof FILE>, lsFiles = '', untracked: Partial<PluginShellExecResult> = {}) {
      const exec = vi.fn(async (_cmd: string, args: readonly string[]) =>
        result(!args.includes('ls-files') ? {} : args.includes('-o') ? untracked : { stdout: lsFiles }));
      const lstat = vi.fn(async (path: string) => tree[path] ?? Promise.reject(enoent()));
      const adds = () => exec.mock.calls.filter(([, args]) => args.includes('add'));
      return { app: { shell: { exec }, fs: { lstat } } as unknown as CoPluginApp, exec, lstat, adds };
    }

    it('T6 a plain directory at the path (the row is ` D x`, the file was replaced by a folder) → refused with an explanation; git add is not run', async () => {
      const { app, adds, exec } = setup({ '/repo/x': DIR }, FILE_ENTRY, { stdout: 'x/work.txt\0' });
      expect(await stageFile(app, '/repo', 'x')).toEqual({ ok: false, error: DIRECTORY_STAGE_ERROR });
      expect(adds()).toEqual([]);
      // 只读的目录查询,路径按字面传
      expect(exec).toHaveBeenCalledWith(
        'git',
        buildGitArgs(['ls-files', '-o', '--exclude-standard', '-z', '--', 'x']),
        expect.objectContaining({ cwd: '/repo', env: expect.objectContaining({ GIT_LITERAL_PATHSPECS: '1' }) }),
      );
      expect(DIRECTORY_STAGE_ERROR).toBe(
        'A directory now sits where this file was. Staging this row would also add every untracked file inside that directory. Nothing was staged — stage the files you want from the Untracked section, or use git in a terminal.',
      );
    });

    it('T7 the directory is the entry itself — a submodule entry in the index (` M sub`), or a nested repository (` T x`: git add would add nothing below it) → staged as before', async () => {
      // 已是子模块条目:不必再问目录里有什么(子模块工作树里的文件本来就列不出来)
      const sub = setup({ '/repo/sub': DIR }, '160000 2c943cce73eac743e3686b3486b10af14c86853b 0\tsub\0', { exitCode: 128 });
      expect(await stageFile(sub.app, '/repo', 'sub')).toEqual({ ok: true });
      expect(sub.adds()).toHaveLength(1);

      const nested = setup({ '/repo/x': DIR, '/repo/x/.git': DIR }, FILE_ENTRY, { stdout: '' });
      expect(await stageFile(nested.app, '/repo', 'x')).toEqual({ ok: true });
      expect(nested.adds()).toHaveLength(1);

      // 只有路径自己的记录算数:目录之下有子模块条目不算(是否放行仍取决于 git add 会不会加入目录里的东西)
      const below = setup({ '/repo/x': DIR }, '160000 2c943cce73eac743e3686b3486b10af14c86853b 0\tx/sub\0', { stdout: 'x/work.txt\0' });
      expect(await stageFile(below.app, '/repo', 'x')).toEqual({ ok: false, error: DIRECTORY_STAGE_ERROR });
      // index 查询失败:不能证明它是条目本身 → 拒绝
      const failing = setup({ '/repo/x': DIR });
      failing.exec.mockImplementation(async (_cmd: string, args: readonly string[]) => result(args.includes('ls-files') ? { exitCode: 128 } : {}));
      expect(await stageFile(failing.app, '/repo', 'x')).toEqual({ ok: false, error: DIRECTORY_STAGE_ERROR });
    });

    it('T9 something called `.git` inside the directory proves nothing (an empty file, an empty folder, a gitfile pointing nowhere — git add still adds everything inside): what counts is whether git add would add anything below the path', async () => {
      const fake = setup({ '/repo/x': DIR, '/repo/x/.git': FILE }, FILE_ENTRY, { stdout: 'x/work.txt\0' });
      expect(await stageFile(fake.app, '/repo', 'x')).toEqual({ ok: false, error: DIRECTORY_STAGE_ERROR });
      expect(fake.adds()).toEqual([]);
      // `.git` 不再被查看
      expect(fake.lstat.mock.calls.map(([path]) => path)).toEqual(['/repo/x']);

      // 子目录是嵌套仓库:会多出 x/inner 这个条目
      const inner = setup({ '/repo/x': DIR }, FILE_ENTRY, { stdout: 'x/inner/\0' });
      expect(await stageFile(inner.app, '/repo', 'x')).toEqual({ ok: false, error: DIRECTORY_STAGE_ERROR });

      // 查不了 → 拒绝:失败、超时、输出被截断而已读到的完整记录里没有证据
      for (const failed of [{ exitCode: 128 }, { exitCode: null, timedOut: true }, { stdout: 'x.txt\0x/wo', truncated: true }]) {
        const unknown = setup({ '/repo/x': DIR }, FILE_ENTRY, failed);
        expect(await stageFile(unknown.app, '/repo', 'x'), JSON.stringify(failed)).toEqual({ ok: false, error: DIRECTORY_STAGE_ERROR });
        expect(unknown.adds()).toEqual([]);
      }
      // 截断之前已经读到一条 → 一样拒绝
      const cut = setup({ '/repo/x': DIR }, FILE_ENTRY, { stdout: 'x/a\0x/b', truncated: true });
      expect(await stageFile(cut.app, '/repo', 'x')).toEqual({ ok: false, error: DIRECTORY_STAGE_ERROR });

      // 只有 `<path>/` 之下的算数:名字只是以同样的字母开头的不算;空目录 / 只有被忽略的文件(没有记录)照常暂存
      for (const stdout of ['', 'x.txt\0xy/z\0']) {
        const ok = setup({ '/repo/x': DIR }, FILE_ENTRY, { stdout });
        expect(await stageFile(ok.app, '/repo', 'x'), JSON.stringify(stdout)).toEqual({ ok: true });
        expect(ok.adds()).toHaveLength(1);
      }
    });

    it('T8 fail-closed when the path cannot be looked at; a missing file (a deletion), a file below a parent that is no longer a folder, a link and a regular file are staged as before; an untracked row is not looked at (the user clicked that very file or folder)', async () => {
      const noFs = setup({});
      expect(await stageFile({ shell: noFs.app.shell } as unknown as CoPluginApp, '/repo', 'a.ts')).toEqual({ ok: false, error: UNVERIFIED_PATH_ERROR });
      expect(noFs.adds()).toEqual([]);
      const denied = setup({});
      denied.lstat.mockRejectedValue(new Error('ScopeError: path is outside granted scopes'));
      expect(await stageFile(denied.app, '/repo', 'a.ts')).toEqual({ ok: false, error: UNVERIFIED_PATH_ERROR });
      expect(denied.adds()).toEqual([]);

      const trees: Array<[Record<string, typeof FILE>, string]> = [
        [{}, 'gone.ts'],
        [{ '/repo/a': FILE }, 'a/b.ts'],
        [{ '/repo/l': { ...FILE, isFile: false, isSymlink: true } }, 'l'],
        [{ '/repo/f.ts': FILE }, 'f.ts'],
      ];
      for (const [tree, path] of trees) {
        const ok = setup(tree);
        expect(await stageFile(ok.app, '/repo', path), path).toEqual({ ok: true });
        expect(ok.adds(), path).toHaveLength(1);
      }

      const untracked = setup({ '/repo/dir': DIR });
      expect(await stageFile(untracked.app, '/repo', 'dir/', { untracked: true })).toEqual({ ok: true });
      expect(untracked.lstat).not.toHaveBeenCalled();
      expect(untracked.exec).toHaveBeenCalledTimes(1);
    });
  });

  // `git add -- x/new` 在 `x` 还是 index 里的文件条目时,同时记下 x 的删除(real-git R87)
  describe('an index entry above the path is not removed along with it', () => {
    const OID = '587be6b4c3f93f93c489c0111bba5596147a26cb';
    function setup(index: Record<string, Partial<PluginShellExecResult>>) {
      const exec = vi.fn(async (_cmd: string, args: readonly string[]) => result(args.includes('ls-files') ? index[args[args.length - 1]!] ?? {} : {}));
      const adds = () => exec.mock.calls.filter(([, args]) => args.includes('add'));
      return { app: { shell: { exec }, fs: FILE_FS } as unknown as CoPluginApp, exec, adds };
    }

    it('T10 an ancestor of the path is an index entry → refused, naming it, for untracked and tracked rows alike; a folder ancestor (its first record is something below it) does not block; a query that cannot be answered refuses', async () => {
      for (const untracked of [true, false]) {
        const { app, adds } = setup({ x: { stdout: `100644 ${OID} 0\tx\0` } });
        expect(await stageFile(app, '/repo', 'x/deep/new', { untracked })).toEqual({ ok: false, error: ancestorStageError('x') });
        expect(adds()).toEqual([]);
      }
      expect(ancestorStageError('x')).toBe(
        '"x" is a file in the index, and this entry sits in a folder of the same name. Staging this row would also stage the removal of "x". Nothing was staged — use git in a terminal.',
      );

      const folder = setup({ x: { stdout: `100644 ${OID} 0\tx/a\0`, truncated: true } });
      expect(await stageFile(folder.app, '/repo', 'x/new', { untracked: true })).toEqual({ ok: true });
      expect(folder.adds()).toHaveLength(1);

      const failing = setup({ x: { exitCode: 128 } });
      expect(await stageFile(failing.app, '/repo', 'x/new', { untracked: true })).toEqual({ ok: false, error: UNVERIFIED_STAGE_ERROR });
      expect(failing.adds()).toEqual([]);
      expect(UNVERIFIED_STAGE_ERROR).toBe(
        'Could not check the index for an entry above this path, so nothing was staged. Refresh and try again, or use git in a terminal.',
      );
    });
  });

  // 祖先逐级串行查询(见 unstage-file-shell T14–T16):此前并行,深路径占满宿主的并发 exec 配额
  describe('the ancestors are asked one at a time, with a depth limit', () => {
    const deepPath = (levels: number) => [...Array.from({ length: levels }, (_, i) => `d${i}`), 'f'].join('/');
    function setup() {
      let active = 0;
      const stat = { peak: 0 };
      const exec = vi.fn(async (_cmd: string, args: readonly string[]) => {
        active += 1;
        stat.peak = Math.max(stat.peak, active);
        await new Promise((r) => setTimeout(r, 0));
        active -= 1;
        return result({});
      });
      const adds = () => exec.mock.calls.filter(([, args]) => args.includes('add'));
      return { app: { shell: { exec }, fs: FILE_FS } as unknown as CoPluginApp, exec, stat, adds };
    }

    it('T11 an untracked path 40 levels deep stages with never more than one git process at a time; more than 64 ancestors → refused with its own message, nothing run', async () => {
      const deep = setup();
      expect(await stageFile(deep.app, '/repo', deepPath(40), { untracked: true })).toEqual({ ok: true });
      expect(deep.stat.peak).toBe(1);
      expect(deep.exec.mock.calls.filter(([, args]) => args.includes('ls-files'))).toHaveLength(40);
      expect(deep.adds()).toHaveLength(1);

      for (const untracked of [true, false]) {
        const tooDeep = setup();
        expect(await stageFile(tooDeep.app, '/repo', deepPath(65), { untracked })).toEqual({ ok: false, error: PATH_TOO_DEEP_ERROR });
        expect(tooDeep.exec).not.toHaveBeenCalled();
      }
    });
  });
});
