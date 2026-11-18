import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { findIndexEntryAtAncestor, GITLINK_MODE, readIndexEntries, wouldAddEntriesInside } from './index-entry';
import { isSafeRepoRelativePath, UNSAFE_PATH_ERROR } from './path-utils';
import { probeWorktreeEntry, UNVERIFIED_PATH_ERROR } from './worktree-entry';

export interface FileOpResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface StageFileOptions {
  /**
   * 该路径是 status 报告的未跟踪条目(`??`)。它的名字来自 git 读目录(按仓库的 core.precomposeUnicode
   * 转换过),`git add` 也要按同样的设置读目录才能找到它——见 exec.ts 的 LITERAL_ARGV_CONFIG。
   */
  readonly untracked?: boolean;
}

// 已跟踪条目的行(` D x`、` M x` …)执行 `git add -- x`。x 的位置上现在是一个普通目录时,git 把目录里
// 所有未跟踪的文件一并加入(实测:` D x` → `D  x` + `A  x/work.txt`)——暂存了这一行从未显示过的内容。
// 照常执行的只有两种情形:
// - index 里这个路径已经是子模块条目(` M sub`):目录就是条目本身;
// - `git add` 不会加入 `<path>/` 之下的任何东西(见 wouldAddEntriesInside):目录是一个真的嵌套仓库
//   (` T x`:git 把它记成一个 gitlink 条目,不进入其中),或目录里没有可加入的内容(空目录、只有被忽略的
//   文件:暂存的只是"x 被删除"这一条)。
// "目录里有个 `.git`"不算数:它可以是空文件、空目录、指向不存在位置的 gitfile——git 不认它是仓库,照样把目录里
// 的文件全部加入(实测 git 2.50 / 2.56;此前只要 lstat 到 `.git` 就放行)。是不是仓库由 git 自己判断。
// 未跟踪的行(`?? x/`)不在此列:用户点的就是那个目录。
export const DIRECTORY_STAGE_ERROR =
  'A directory now sits where this file was. Staging this row would also add every untracked file inside that directory. ' +
  'Nothing was staged — stage the files you want from the Untracked section, or use git in a terminal.';

// 反方向(见 index-entry 的 findIndexEntryAtAncestor):`x` 还是 index 里的文件条目,而这一行是 `x/new`
// (用户设了 status.showUntrackedFiles=all 时 ` D x` 与 `?? x/new` 同时列出;或列表已过时)。`git add -- x/new`
// 会同时记下 `x` 的删除(实测:`D  x` + `A  x/new`)。未跟踪的行同样要查。
export const ancestorStageError = (ancestor: string): string =>
  `"${ancestor}" is a file in the index, and this entry sits in a folder of the same name. ` +
  `Staging this row would also stage the removal of "${ancestor}". Nothing was staged — use git in a terminal.`;

export const UNVERIFIED_STAGE_ERROR =
  'Could not check the index for an entry above this path, so nothing was staged. Refresh and try again, or use git in a terminal.';

const PROBE_TIMEOUT_MS = 5_000;

/** 该路径上现在是目录:`git add -- <path>` 是否只作用于这一个条目。查不了 → false(拒绝)。 */
async function addStaysOnTheEntry(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
): Promise<boolean> {
  const entries = await readIndexEntries(app, repoRoot, path, PROBE_TIMEOUT_MS);
  if (entries === null) return false;
  if (entries.some((entry) => entry.mode === GITLINK_MODE)) return true;
  return (await wouldAddEntriesInside(app, repoRoot, path, PROBE_TIMEOUT_MS)) === false;
}

export async function stageFile(
  app: Pick<CoPluginApp, 'shell'> & Partial<Pick<CoPluginApp, 'fs'>>,
  repoRoot: string,
  path: string,
  opts: StageFileOptions = {},
): Promise<FileOpResult> {
  if (!isSafeRepoRelativePath(path)) return { ok: false, error: UNSAFE_PATH_ERROR };
  if (!opts.untracked) {
    // 看不了 → 不暂存(fail-closed)。父级不是目录(parent-not-directory)时 `git add` 只会记下这条路径的删除,照常执行。
    const entry = await probeWorktreeEntry(app, repoRoot, path);
    if (entry.kind === 'unknown') return { ok: false, error: UNVERIFIED_PATH_ERROR };
    if (entry.kind === 'directory' && !(await addStaysOnTheEntry(app, repoRoot, path))) {
      return { ok: false, error: DIRECTORY_STAGE_ERROR };
    }
  }
  const ancestor = await findIndexEntryAtAncestor(app, repoRoot, path, PROBE_TIMEOUT_MS);
  if (ancestor === null) return { ok: false, error: UNVERIFIED_STAGE_ERROR };
  if (ancestor !== false) return { ok: false, error: ancestorStageError(ancestor) };
  const result = await gitExec(app, repoRoot, ['add', '--', path], {
    timeoutMs: 10_000,
    ...(opts.untracked ? { untrackedPathArgs: true } : {}),
  });

  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: result.stderr || `git add exit ${result.exitCode ?? 'unknown'}`,
  };
}
