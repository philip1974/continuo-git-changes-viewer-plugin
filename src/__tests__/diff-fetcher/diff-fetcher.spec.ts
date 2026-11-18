import { describe, expect, it, vi } from 'vitest';
import { fetchDiff, MAX_FILE_BYTES } from '../../git/diff-fetcher';
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
    const exec = vi.fn(async (cmd: string, args: readonly string[], _opts?: { maxOutputBytes?: number }) => result(byCommand(cmd, args)));
    const lstat = vi.fn().mockResolvedValue({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false });
    return { app: { shell: { exec }, fs: { lstat } } as unknown as CoPluginApp, exec };
  }
  const isHeadRead = (cmd: string, args: readonly string[]) => cmd === 'git' && args.includes('cat-file');

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
    await expect(fetchDiff(big.app, '/repo', { path: 'big.bin', status: 'A', statusX: 'A', statusY: ' ', kind: 'text' }, 'staged')).resolves.toMatchObject({
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
});
