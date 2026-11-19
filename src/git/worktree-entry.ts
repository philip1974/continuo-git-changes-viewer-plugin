import type { CoPluginApp } from '../sdk/types';
import { isNotFoundError } from './fs-errors';
import { isSafeRepoRelativePath } from './path-utils';

type FsApp = Partial<Pick<CoPluginApp, 'fs'>>;

/**
 * 工作树里这个仓库内相对路径上**现在**是什么(app.fs.lstat:不跟随链接、不读内容):
 * - missing:路径不存在(某一级父目录不存在也算);
 * - file / symlink / directory / other:路径本身的类型(other:FIFO、设备、socket);
 * - parent-not-directory:某一级父目录的位置上不是目录(普通文件、符号链接 …),`parent` 是那一级的仓库内路径;
 * - unknown:看不了(无 app.fs / lstat、scope 错误、EACCES、路径不规范)。调用方按 fail-closed 处理。
 *
 * 为什么需要:文件级操作把路径当参数交给 git,而 git 把路径当**前缀**用——该位置现在是目录时,
 * `checkout -- x` 递归删掉整个目录(含未跟踪的内容),`add -- x` 把目录里的未跟踪文件全部加入。
 * status 行(` D x` / ` T x`)不说明磁盘上这个位置现在是什么。
 * 自上而下逐级查看,遇到第一个不是目录的父级即停。查看与随后的 git 命令之间有极小的时间窗。
 */
export type WorktreeEntry =
  | { readonly kind: 'missing' | 'file' | 'symlink' | 'directory' | 'other' | 'unknown' }
  | { readonly kind: 'parent-not-directory'; readonly parent: string };

export async function probeWorktreeEntry(app: FsApp, repoRoot: string, path: string): Promise<WorktreeEntry> {
  const fs = app.fs;
  if (!fs || typeof fs.lstat !== 'function' || !isSafeRepoRelativePath(path)) return { kind: 'unknown' };
  const segments = path.split('/').filter((s) => s !== '');
  const root = repoRoot.replace(/[\\/]+$/, '');
  for (let i = 0; i < segments.length; i++) {
    const rel = segments.slice(0, i + 1).join('/');
    let st;
    try {
      st = await fs.lstat(`${root}/${rel}`);
    } catch (err) {
      return { kind: isNotFoundError(err) ? 'missing' : 'unknown' };
    }
    const kind = st.isSymlink ? 'symlink' : st.isDirectory === true ? 'directory' : st.isFile === true ? 'file' : 'other';
    if (i === segments.length - 1) return { kind };
    if (kind !== 'directory') return { kind: 'parent-not-directory', parent: rel };
  }
  return { kind: 'unknown' };
}

export const UNVERIFIED_PATH_ERROR =
  'Could not check what is at this path in the working tree right now, so nothing was changed. Refresh and try again, or use git in a terminal.';
