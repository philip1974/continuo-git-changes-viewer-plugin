import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { findIndexEntryAtAncestor, hasIndexEntriesInside, isDirectoryInHead } from './index-entry';
import { isSafeRepoRelativePath, UNSAFE_PATH_ERROR } from './path-utils';
import type { FileOpResult } from './stage-file';

let restoreSupported: boolean | null = null;

const USAGE_EXIT_CODE = 129;
const UNKNOWN_COMMAND_EXIT_CODE = 1;

async function supportsRestore(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<boolean> {
  if (restoreSupported !== null) return restoreSupported;

  const result = await gitExec(app, repoRoot, ['restore', '-h'], {
    timeoutMs: 5_000,
  });
  // `git <cmd> -h` 打印用法:git 2.5x 之前以 129 退出(实测 2.50.1),较新的版本以 0 退出(实测 2.56.1);
  // 命令不存在是 1(`'restore' is not a git command`;按退出码判断,消息会随语言环境变化)。
  // 只缓存这两种确定的结果。超时、被信号终止、被仓库守卫拒绝(128)等都没有说明 git 支持什么:此前它们
  // 也被永久记成"不支持"——一次超时之后整个会话都走 reset。这些情况不缓存,本次走 reset 兜底,下次再探测。
  if (result.timedOut) return false;
  if (result.exitCode === 0 || result.exitCode === USAGE_EXIT_CODE) return (restoreSupported = true);
  if (result.exitCode === UNKNOWN_COMMAND_EXIT_CODE) return (restoreSupported = false);
  return false;
}

export function _resetRestoreCache(): void {
  restoreSupported = null;
}

// `git restore --staged -- x`(以及兜底的 `git reset HEAD -- x`)把 x 当前缀:index 里 `x/…` 的条目也一并
// 撤销暂存。`D  x` + `AM x/work.txt`(文件换成目录后整体暂存,之后又改了里面的文件)时,点 x 那一行会把
// x/work.txt 暂存的那一版从 index 里拿掉——用户没有点它,那一版内容也找不回来(实测 git 2.50 / 2.56)。
export const DIRECTORY_UNSTAGE_ERROR =
  'Other staged entries sit inside a directory of this name. Unstaging this row would unstage them too. ' +
  'Nothing was changed — unstage those entries first, or use git in a terminal.';

// 反方向(见 index-entry 的 findIndexEntryAtAncestor):`D  x/a` 而 `x` 是已暂存的文件——把 x/a 取回 index 会把
// `x` 这个条目拿掉。先撤销 `x` 也不行(下一条),所以只指向终端。
export const ancestorUnstageError = (ancestor: string): string =>
  `"${ancestor}" is staged as a file, and this entry belongs to a folder of the same name in the last commit. ` +
  `Unstaging this row would drop "${ancestor}" from the index as well. Nothing was changed — use git in a terminal.`;

// 同一个前缀问题的 HEAD 一侧:`A  x` 而 HEAD 里 x 是目录(`D  x/a` …)——`restore --staged -- x` 把 HEAD 里
// `x/…` 的条目全部取回 index,那些"已暂存的删除"一并被撤销(实测 git 2.50 / 2.56)。
export const HEAD_DIRECTORY_UNSTAGE_ERROR =
  'In the last commit this path is a folder. Unstaging this row would also unstage the deletions staged for the files in it. ' +
  'Nothing was changed — use git in a terminal.';

export const UNVERIFIED_INDEX_ERROR =
  'Could not check the index for entries below this path, so nothing was unstaged. Refresh and try again, or use git in a terminal.';
// (同一文案也用于"查不了祖先条目 / HEAD 里这个路径是什么"——都是"无法确认只动这一条")

const PROBE_TIMEOUT_MS = 5_000;

export async function unstageFile(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
): Promise<FileOpResult> {
  if (!isSafeRepoRelativePath(path)) return { ok: false, error: UNSAFE_PATH_ERROR };
  // 查不了 → 不撤销(fail-closed)
  const inside = await hasIndexEntriesInside(app, repoRoot, path, PROBE_TIMEOUT_MS);
  if (inside === null) return { ok: false, error: UNVERIFIED_INDEX_ERROR };
  if (inside) return { ok: false, error: DIRECTORY_UNSTAGE_ERROR };
  const ancestor = await findIndexEntryAtAncestor(app, repoRoot, path, PROBE_TIMEOUT_MS);
  if (ancestor === null) return { ok: false, error: UNVERIFIED_INDEX_ERROR };
  if (ancestor !== false) return { ok: false, error: ancestorUnstageError(ancestor) };
  const headDirectory = await isDirectoryInHead(app, repoRoot, path, PROBE_TIMEOUT_MS);
  if (headDirectory === null) return { ok: false, error: UNVERIFIED_INDEX_ERROR };
  if (headDirectory) return { ok: false, error: HEAD_DIRECTORY_UNSTAGE_ERROR };
  const useRestore = await supportsRestore(app, repoRoot);
  const args = useRestore
    ? ['restore', '--staged', '--', path]
    : ['reset', 'HEAD', '--', path];
  const result = await gitExec(app, repoRoot, args, {
    timeoutMs: 10_000,
  });

  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: result.stderr || `unstage exit ${result.exitCode ?? 'unknown'}`,
  };
}
