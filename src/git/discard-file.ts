import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { GITLINK_MODE, readIndexEntries } from './index-entry';
import { isSafeRepoRelativePath, UNSAFE_PATH_ERROR } from './path-utils';
import type { FileOpResult } from './stage-file';
import { probeWorktreeEntry, UNVERIFIED_PATH_ERROR } from './worktree-entry';

// `git checkout -- <子模块>` 以 0 退出而什么都不做(不带 --recurse-submodules 时 checkout 不动子模块的工作树;
// 插件也不递归进子模块):照常执行的话面板会报 "Discarded sub",而条目原样还在。
export const SUBMODULE_DISCARD_ERROR =
  'This entry is a submodule: there is no file content to discard here. To undo its change, use git in a terminal ' +
  '(for example `git submodule update`, or check out the recorded commit inside the submodule).';

// `git checkout -- x` 在 x 的位置上现在是目录时,递归删掉整个目录再写回文件——目录里 git 不跟踪的内容
// (未保存的工作、嵌套仓库连同它的 .git)一并消失,而确认框只写着 `File: x`(实测 git 2.50 / 2.56:
// 文件换成普通目录是 ` D x`,换成嵌套仓库是 ` T x`)。
export const DIRECTORY_DISCARD_ERROR =
  'A directory now sits where this file was. Discarding would delete that directory and everything in it, ' +
  'including files git does not track. Nothing was changed — move the directory away yourself, or use git in a terminal.';

// 同一类:`a/b` 的父目录 `a` 现在是一个文件(或链接)时,`git checkout -- a/b` 先把它删掉再建目录。
export const parentNotDirectoryDiscardError = (parent: string): string =>
  `"${parent}" is no longer a folder: a file or link now sits there. Discarding would delete it to restore this file. ` +
  'Nothing was changed — move it away yourself, or use git in a terminal.';

const PROBE_TIMEOUT_MS = 5_000;

export async function discardFile(
  app: Pick<CoPluginApp, 'shell'> & Partial<Pick<CoPluginApp, 'fs'>>,
  repoRoot: string,
  path: string,
): Promise<FileOpResult> {
  if (!isSafeRepoRelativePath(path)) return { ok: false, error: UNSAFE_PATH_ERROR };
  // 探测失败(null)不拦:不知道就照常 checkout——文件的丢弃不该因为一次探测超时而做不了。
  const entries = await readIndexEntries(app, repoRoot, path, PROBE_TIMEOUT_MS);
  if (entries?.some((entry) => entry.mode === GITLINK_MODE)) return { ok: false, error: SUBMODULE_DISCARD_ERROR };
  // 工作树里这个位置现在是什么(见 worktree-entry)。看不了 → 不 checkout(fail-closed:这是破坏性操作)。
  const entry = await probeWorktreeEntry(app, repoRoot, path);
  if (entry.kind === 'unknown') return { ok: false, error: UNVERIFIED_PATH_ERROR };
  if (entry.kind === 'directory') return { ok: false, error: DIRECTORY_DISCARD_ERROR };
  if (entry.kind === 'parent-not-directory') return { ok: false, error: parentNotDirectoryDiscardError(entry.parent) };
  const result = await gitExec(app, repoRoot, ['checkout', '--', path], {
    timeoutMs: 10_000,
  });

  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: result.stderr || `git checkout -- exit ${result.exitCode ?? 'unknown'}`,
  };
}
