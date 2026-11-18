import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';

/**
 * 仓库状态的指纹:自动刷新的 tick 用它判断"有没有变",没变就不刷新。
 *
 * 用 porcelain v2,不是 v1:v1 只有 XY 两个字母——已暂存的文件再次修改并 `git add` 之后仍是 `M  f`,
 * 指纹不变、面板不刷新,Staged 区继续显示第一次暂存的内容,而 Commit 提交的是第二次的。v2 的每条记录带
 * HEAD 与 index 里的对象 id(`<hH> <hI>`),暂存内容的任何变化都会改变输出。只读,与 v1 同一条命令。
 *
 * 不覆盖的:工作树文件的内容(status 不为未暂存的文件输出 id)——同一个未暂存文件再次被编辑时 XY 与 id
 * 都不变。面板为此另外比较当前显示的工作树 diff 的 worktreeStamp(见 diff-fetcher 的 isWorktreeDiffStale)。
 */
export async function readStatusHash(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<string> {
  const result = await gitExec(
    app,
    repoRoot,
    ['status', '--porcelain=v2', '-z'],
    { timeoutMs: 5000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git status failed: ${result.stderr}`);
  }
  return result.stdout;
}
