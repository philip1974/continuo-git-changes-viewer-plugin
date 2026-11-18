import { describe, expect, it, vi } from 'vitest';
import { fetchDiff, FILE_READ_TIMEOUT_MS, MAX_FILE_BYTES } from '../../git/diff-fetcher';
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

function makeApp(shellResult: PluginShellExecResult) {
  const exec = vi.fn().mockResolvedValue(shellResult);
  return {
    // 读工作树全文前要经 app.fs.lstat 确认路径不是符号链接(见 diff-symlink-guard)
    app: {
      shell: { exec },
      fs: {
        lstat: vi.fn().mockResolvedValue({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false }),
      },
    } as unknown as CoPluginApp,
    exec,
  };
}

describe('tracked diff fetcher', () => {
  it('T1 fetches HEAD + WT + unified diff for tracked file', async () => {
    // v0.1.3: returns {original, modified, unifiedDiff, isUntracked:false} not {diff}
    const { app, exec } = makeApp(result({ stdout: 'diff --git a/a.ts b/a.ts\n' }));

    await expect(
      fetchDiff(app, '/repo', { path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }),
    ).resolves.toEqual({
      ok: true,
      path: 'src/a.ts',
      original: 'diff --git a/a.ts b/a.ts\n', // shared mock; real impl returns HEAD blob
      modified: 'diff --git a/a.ts b/a.ts\n', // shared mock; real impl returns WT content
      unifiedDiff: 'diff --git a/a.ts b/a.ts\n',
      isUntracked: false,
    });
    // v0.3.0 spawns 3 parallel calls: git cat-file blob HEAD:<path>, cat <path>, git diff -- <path>
    // (cat-file, not show: `git show HEAD:a..b` parses the argument as a revision range)
    expect(exec).toHaveBeenCalledWith(
      'git',
      buildGitArgs(['cat-file', 'blob', 'HEAD:src/a.ts']),
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(exec).toHaveBeenCalledWith(
      'cat',
      ['--', 'src/a.ts'],
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(exec).toHaveBeenCalledWith(
      'git',
      buildGitArgs(['diff', '--', 'src/a.ts']),
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('T2 maps truncated unified diff to too-large with exact command', async () => {
    const { app } = makeApp(result({ stdout: 'partial', truncated: true }));

    await expect(
      fetchDiff(app, '/repo', { path: 'large.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'too-large',
      path: 'large.txt',
      exactCommand: 'git diff -- large.txt',
    });
  });

  // 按命令返回不同结果的 exec 替身
  function appWith(byCommand: (cmd: string, args: readonly string[]) => Partial<PluginShellExecResult>) {
    const exec = vi.fn(async (cmd: string, args: readonly string[], _opts?: { maxOutputBytes?: number; timeoutMs?: number }) => result(byCommand(cmd, args)));
    const lstat = vi.fn().mockResolvedValue({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false });
    return { app: { shell: { exec }, fs: { lstat } } as unknown as CoPluginApp, exec };
  }
  const isHeadRead = (cmd: string, args: readonly string[]) => cmd === 'git' && args.includes('cat-file') && args.some((a) => a.startsWith('HEAD:'));
  const isIndexRead = (cmd: string, args: readonly string[]) => cmd === 'git' && args.includes('cat-file') && args.some((a) => a.startsWith(':0:'));
  const isLsFiles = (cmd: string, args: readonly string[]) => cmd === 'git' && args.includes('ls-files');

  it('T3 whole-file reads carry an explicit size limit (1 MiB) instead of relying on the host default; the unified diff keeps the host default', async () => {
    expect(MAX_FILE_BYTES).toBe(1024 * 1024);
    const { app, exec } = appWith(() => ({ stdout: 'x\n' }));
    await fetchDiff(app, '/repo', { path: 'a.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' });
    await fetchDiff(app, '/repo', { path: 'new.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' });

    const limits = exec.mock.calls.map(([cmd, args, opts]) => [cmd === 'cat' ? 'cat' : args.includes('cat-file') ? 'cat-file' : 'diff', opts?.maxOutputBytes]);
    expect(limits).toEqual(expect.arrayContaining([['cat-file', MAX_FILE_BYTES], ['cat', MAX_FILE_BYTES], ['diff', undefined]]));
    expect(limits.filter(([what]) => what === 'cat')).toEqual([['cat', MAX_FILE_BYTES], ['cat', MAX_FILE_BYTES]]);
  });

  it('T4 a working-tree file over the limit: the part that was read is returned and flagged modifiedTruncated (new / untracked files show it with a notice); a file within the limit carries no flag', async () => {
    const big = appWith((cmd) => (cmd === 'cat' ? { stdout: 'first part', truncated: true } : { stdout: '' }));
    await expect(fetchDiff(big.app, '/repo', { path: 'big.bin', status: 'U', statusX: '?', statusY: '?', kind: 'text' })).resolves.toEqual({
      ok: true, path: 'big.bin', original: '', modified: 'first part', unifiedDiff: '', isUntracked: true, modifiedTruncated: true,
    });
    // staged 模式的新版来自 index(T6):同样的上限与标记
    const bigStaged = appWith((cmd, args) => (isIndexRead(cmd, args) ? { stdout: 'first part', truncated: true } : { stdout: '' }));
    await expect(fetchDiff(bigStaged.app, '/repo', { path: 'big.bin', status: 'A', statusX: 'A', statusY: ' ', kind: 'text' }, 'staged')).resolves.toMatchObject({
      ok: true, modified: 'first part', modifiedTruncated: true,
    });

    const small = appWith(() => ({ stdout: 'all of it' }));
    const d = await fetchDiff(small.app, '/repo', { path: 's.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' });
    expect(d).not.toHaveProperty('modifiedTruncated');
  });

  it('T5 a HEAD blob over the limit does not fail the diff: the original is only the part that was read (the panel uses it to tell "no HEAD version" apart), the unified diff decides what is shown', async () => {
    const { app } = appWith((cmd, args) => (isHeadRead(cmd, args) ? { stdout: 'head part', truncated: true } : cmd === 'cat' ? { stdout: 'wt' } : { stdout: 'diff --git a/a b/a\n' }));
    await expect(fetchDiff(app, '/repo', { path: 'a', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' })).resolves.toEqual({
      ok: true, path: 'a', original: 'head part', modified: 'wt', unifiedDiff: 'diff --git a/a b/a\n', isUntracked: false,
    });
  });

  it('T6 staged mode reads the new side from the index (`cat-file blob :0:<path>`, 1 MiB limit) and never runs cat on the working tree; changed mode keeps reading the working tree', async () => {
    const byCommand = (cmd: string, args: readonly string[]) =>
      isIndexRead(cmd, args) ? { stdout: 'INDEX' } : isHeadRead(cmd, args) ? { stdout: 'HEAD' } : cmd === 'cat' ? { stdout: 'WORKTREE' } : { stdout: 'diff\n' };
    const change = { path: 'src/n.txt', status: 'A', statusX: 'A', statusY: 'M', kind: 'text' } as const;

    const staged = appWith(byCommand);
    await expect(fetchDiff(staged.app, '/repo', change, 'staged')).resolves.toMatchObject({ ok: true, original: 'HEAD', modified: 'INDEX' });
    expect(staged.exec.mock.calls.filter(([cmd]) => cmd === 'cat')).toEqual([]);
    expect(staged.exec).toHaveBeenCalledWith(
      'git',
      buildGitArgs(['cat-file', 'blob', ':0:src/n.txt']),
      expect.objectContaining({ cwd: '/repo', maxOutputBytes: MAX_FILE_BYTES }),
    );

    const changed = appWith(byCommand);
    await expect(fetchDiff(changed.app, '/repo', change, 'changed')).resolves.toMatchObject({ ok: true, modified: 'WORKTREE' });
    expect(changed.exec.mock.calls.filter(([cmd, args]) => isIndexRead(cmd, args))).toEqual([]);
  });

  it('T7 staged mode: a staged deletion reads nothing for the new side; a path without a stage-0 blob (cat-file fails) is flagged no-staged-blob; a worktree-only deletion (` D` shown in Changes) reads nothing from the working tree', async () => {
    const del = appWith(() => ({ stdout: 'x' }));
    const d = await fetchDiff(del.app, '/repo', { path: 'gone.txt', status: 'D', statusX: 'D', statusY: ' ', kind: 'text' }, 'staged');
    expect(d).toMatchObject({ ok: true, modified: '' });
    expect(d).not.toHaveProperty('withheld');
    expect(del.exec.mock.calls.filter(([cmd, args]) => cmd === 'cat' || isIndexRead(cmd, args))).toEqual([]);

    // `MD`:已暂存修改、工作树删除——合并后的 status 是 D,但 Staged 区仍有 index 版本
    const md = appWith((cmd, args) => (isIndexRead(cmd, args) ? { stdout: 'INDEX' } : { stdout: 'x' }));
    await expect(fetchDiff(md.app, '/repo', { path: 'm.txt', status: 'D', statusX: 'M', statusY: 'D', kind: 'text' }, 'staged')).resolves.toMatchObject({ ok: true, modified: 'INDEX' });
    await expect(fetchDiff(md.app, '/repo', { path: 'm.txt', status: 'D', statusX: 'M', statusY: 'D', kind: 'text' }, 'changed')).resolves.toMatchObject({ ok: true, modified: '' });
    expect(md.exec.mock.calls.filter(([cmd]) => cmd === 'cat')).toEqual([]);

    const none = appWith((cmd, args) =>
      isIndexRead(cmd, args) ? { exitCode: 128, stderr: 'fatal: path is in the index, but not at stage 0' }
        : isLsFiles(cmd, args) ? { stdout: `160000 ${'a'.repeat(40)} 0\tsub\x00` } : { stdout: 'x' });
    await expect(fetchDiff(none.app, '/repo', { path: 'sub', status: 'A', statusX: 'A', statusY: ' ', kind: 'text' }, 'staged')).resolves.toMatchObject({
      ok: true, modified: '', withheld: 'no-staged-blob',
    });
  });

  it('T10 a failed index read is only called "submodule or conflict" when it is one: unmerged status (no extra command), or `ls-files -s` showing a gitlink / stages 1–3; every other failure (refused, killed, stage-0 blob that could not be read, ls-files itself failing) is flagged staged-unreadable', async () => {
    const failRead = (lsFiles: Partial<PluginShellExecResult>) =>
      appWith((cmd, args) => (isIndexRead(cmd, args) ? { exitCode: 128, stderr: 'fatal: boom' } : isLsFiles(cmd, args) ? lsFiles : { stdout: 'x' }));
    const added = (path: string, x: 'A' | 'M' | 'U' | 'D' = 'A', y: ' ' | 'A' | 'U' | 'D' | 'M' = ' ') =>
      ({ path, status: 'A', statusX: x, statusY: y, kind: 'text' }) as const;
    const withheld = async (app: CoPluginApp, change: ReturnType<typeof added>) => {
      const d = await fetchDiff(app, '/repo', change, 'staged');
      return d.ok ? d.withheld : d;
    };
    const oid = 'b'.repeat(40);

    // 未解决的冲突:status 已经说明,不再起命令
    for (const [x, y] of [['U', 'U'], ['A', 'A'], ['A', 'U'], ['U', 'A'], ['U', 'D']] as const) {
      const { app, exec } = failRead({ stdout: '' });
      expect({ x, y, withheld: await withheld(app, added('both.txt', x, y)) }).toEqual({ x, y, withheld: 'no-staged-blob' });
      expect(exec.mock.calls.filter(([cmd, args]) => isLsFiles(cmd, args))).toEqual([]);
    }

    // gitlink / 只有 stage 1–3
    const gitlink = failRead({ stdout: `160000 ${oid} 0\tsub\x00` });
    expect(await withheld(gitlink.app, added('sub'))).toBe('no-staged-blob');
    expect(gitlink.exec).toHaveBeenCalledWith('git', buildGitArgs(['ls-files', '-s', '-z', '--', 'sub']), expect.objectContaining({ cwd: '/repo', timeoutMs: FILE_READ_TIMEOUT_MS }));
    expect(await withheld(failRead({ stdout: `100644 ${oid} 2\tc.txt\x00100644 ${oid} 3\tc.txt\x00` }).app, added('c.txt', 'M'))).toBe('no-staged-blob');

    // 其它:普通的 stage-0 blob 却没读出来;ls-files 被拒绝 / 被杀 / 超时 / 截断 / 没有这个条目 / 输出看不懂
    for (const lsFiles of [
      { stdout: `100644 ${oid} 0\tn.txt\x00` },
      { stdout: `120000 ${oid} 0\tn.txt\x00` },
      { exitCode: 128, stderr: 'Git commands are disabled for this repository' },
      { exitCode: null, signal: 'SIGKILL' },
      { stdout: `160000 ${oid} 0\tn.txt\x00`, timedOut: true, exitCode: null },
      { stdout: `160000 ${oid} 0\tn.txt\x00`, truncated: true },
      { stdout: '' },
      { stdout: 'garbage' },
      // 另一条路径的记录(目录前缀匹配到的子路径)不算
      { stdout: `160000 ${oid} 0\tn.txt/inner\x00` },
    ] as Partial<PluginShellExecResult>[]) {
      expect({ lsFiles, withheld: await withheld(failRead(lsFiles).app, added('n.txt')) }).toEqual({ lsFiles, withheld: 'staged-unreadable' });
    }

    // 读成功时不起 ls-files
    const fine = appWith((cmd, args) => (isIndexRead(cmd, args) ? { stdout: 'INDEX' } : { stdout: 'x' }));
    await fetchDiff(fine.app, '/repo', added('n.txt'), 'staged');
    expect(fine.exec.mock.calls.filter(([cmd, args]) => isLsFiles(cmd, args))).toEqual([]);
  });

  it('T11 changed mode decides "nothing on the new side" from the working-tree column: `AD` (merged status A) and `RD` read nothing from the working tree', async () => {
    for (const [x, status] of [['A', 'A'], ['R', 'R'], [' ', 'D'], ['M', 'D']] as const) {
      const { app, exec } = appWith(() => ({ stdout: 'x' }));
      const d = await fetchDiff(app, '/repo', { path: 'gone.txt', status, statusX: x, statusY: 'D', kind: 'text' }, 'changed');
      expect({ x, modified: d.ok && d.modified }).toEqual({ x, modified: '' });
      expect(exec.mock.calls.filter(([cmd]) => cmd === 'cat')).toEqual([]);
    }
  });

  it('T12 a new symbolic link is recognised from the diff header (`new file mode 120000`) and flagged modifiedIsSymlink; a regular new file, a mode line inside a hunk, and a link that already existed are not', async () => {
    const header = (mode: string) => `diff --git a/ln b/ln\nnew file mode ${mode}\nindex 0000000..1de5659\n--- /dev/null\n+++ b/ln\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n`;
    const flagged = async (unifiedDiff: string) => {
      const { app } = appWith((cmd, args) => (isIndexRead(cmd, args) ? { stdout: 'target' } : isHeadRead(cmd, args) ? { exitCode: 128 } : { stdout: unifiedDiff }));
      const d = await fetchDiff(app, '/repo', { path: 'ln', status: 'A', statusX: 'A', statusY: ' ', kind: 'text' }, 'staged');
      return d.ok ? d.modifiedIsSymlink ?? false : d;
    };
    expect(await flagged(header('120000'))).toBe(true);
    expect(await flagged(header('100644'))).toBe(false);
    expect(await flagged(header('100755'))).toBe(false);
    // 文件内容里的同样文字(hunk 内的行以 + 开头;即便没有前缀,@@ 之后也不看)
    expect(await flagged('diff --git a/ln b/ln\nnew file mode 100644\n--- /dev/null\n+++ b/ln\n@@ -0,0 +2 @@\n+x\nnew file mode 120000\n')).toBe(false);
    expect(await flagged('diff --git a/ln b/ln\nindex 1..2 120000\n--- a/ln\n+++ b/ln\n@@ -1 +1 @@\n-a\n+b\n')).toBe(false);
    expect(await flagged('')).toBe(false);
  });

  it('T8 the three whole-file reads (HEAD blob, index blob, working-tree cat) carry a short explicit timeout; the unified diff keeps the host default', async () => {
    expect(FILE_READ_TIMEOUT_MS).toBe(5_000);
    const { app, exec } = appWith(() => ({ stdout: 'x\n' }));
    const change = { path: 'a.txt', status: 'M', statusX: 'M', statusY: 'M', kind: 'text' } as const;
    await fetchDiff(app, '/repo', change, 'changed');
    await fetchDiff(app, '/repo', change, 'staged');

    const what = (cmd: string, args: readonly string[]) => (cmd === 'cat' ? 'cat' : isHeadRead(cmd, args) ? 'head' : isIndexRead(cmd, args) ? 'index' : 'diff');
    const timeouts = exec.mock.calls.map(([cmd, args, opts]) => [what(cmd, args), opts?.timeoutMs]);
    expect(timeouts.sort()).toEqual([
      ['cat', FILE_READ_TIMEOUT_MS],
      ['diff', undefined],
      ['diff', undefined],
      ['head', FILE_READ_TIMEOUT_MS],
      ['head', FILE_READ_TIMEOUT_MS],
      ['index', FILE_READ_TIMEOUT_MS],
    ]);
  });

  it('T9 a whole-file read that times out is treated like an oversized one: the part that was read, flagged modifiedTruncated + modifiedTimedOut (working tree and index alike); a HEAD read that times out does not fail the diff', async () => {
    const killed = { stdout: 'read so far', exitCode: null, signal: 'SIGTERM', timedOut: true };
    const wt = appWith((cmd) => (cmd === 'cat' ? killed : { stdout: '' }));
    await expect(fetchDiff(wt.app, '/repo', { path: 'slow.bin', status: 'U', statusX: '?', statusY: '?', kind: 'text' })).resolves.toEqual({
      ok: true, path: 'slow.bin', original: '', modified: 'read so far', unifiedDiff: '', isUntracked: true, modifiedTruncated: true, modifiedTimedOut: true,
    });

    const idx = appWith((cmd, args) => (isIndexRead(cmd, args) ? killed : { stdout: '' }));
    const staged = await fetchDiff(idx.app, '/repo', { path: 'slow.bin', status: 'A', statusX: 'A', statusY: ' ', kind: 'text' }, 'staged');
    expect(staged).toMatchObject({ ok: true, modified: 'read so far', modifiedTruncated: true, modifiedTimedOut: true });
    expect(staged).not.toHaveProperty('withheld');

    const head = appWith((cmd, args) => (isHeadRead(cmd, args) ? killed : cmd === 'cat' ? { stdout: 'wt' } : { stdout: 'diff --git a/a b/a\n' }));
    const d = await fetchDiff(head.app, '/repo', { path: 'a', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' });
    expect(d).toEqual({ ok: true, path: 'a', original: 'read so far', modified: 'wt', unifiedDiff: 'diff --git a/a b/a\n', isUntracked: false });

    // 只是超过大小上限(未超时):不带 modifiedTimedOut
    const big = appWith((cmd) => (cmd === 'cat' ? { stdout: 'first part', truncated: true } : { stdout: '' }));
    expect(await fetchDiff(big.app, '/repo', { path: 'big.bin', status: 'U', statusX: '?', statusY: '?', kind: 'text' })).not.toHaveProperty('modifiedTimedOut');
  });
});
