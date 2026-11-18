import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { GITLINK_MODE, readIndexEntries } from './index-entry';
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
// 只有"这个目录就是条目本身"时才照常执行:index 里它是子模块条目(` M sub`),或目录是一个嵌套仓库
// (` T x`:git 把它记成一个 gitlink 条目,不进入其中)。未跟踪的行(`?? x/`)不在此列:用户点的就是那个目录。
export const DIRECTORY_STAGE_ERROR =
  'A directory now sits where this file was. Staging this row would also add every untracked file inside that directory. ' +
  'Nothing was staged — stage the files you want from the Untracked section, or use git in a terminal.';

const PROBE_TIMEOUT_MS = 5_000;

async function directoryIsTheEntry(
  app: Pick<CoPluginApp, 'shell'> & Partial<Pick<CoPluginApp, 'fs'>>,
  repoRoot: string,
  path: string,
): Promise<boolean> {
  const entries = await readIndexEntries(app, repoRoot, path, PROBE_TIMEOUT_MS);
  if (entries?.some((entry) => entry.mode === GITLINK_MODE)) return true;
  // 嵌套仓库:目录里有 `.git`(文件或目录)。`.git` 是 isSafeRepoRelativePath 拒绝的段名,这里直接 lstat;
  // 任何失败(不存在、看不了)都按"不是"处理 → 拒绝。
  try {
    await app.fs!.lstat(`${repoRoot.replace(/[\\/]+$/, '')}/${path}/.git`);
    return true;
  } catch {
    return false;
  }
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
    if (entry.kind === 'directory' && !(await directoryIsTheEntry(app, repoRoot, path))) {
      return { ok: false, error: DIRECTORY_STAGE_ERROR };
    }
  }
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
