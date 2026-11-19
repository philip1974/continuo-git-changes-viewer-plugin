import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { failureDetail } from './status-scanner';

/**
 * 仓库状态的指纹:自动刷新的 tick 用它判断"有没有变",没变就不刷新。
 *
 * 用 porcelain v2,不是 v1:v1 只有 XY 两个字母——已暂存的文件再次修改并 `git add` 之后仍是 `M  f`,
 * 指纹不变、面板不刷新,Staged 区继续显示第一次暂存的内容,而 Commit 提交的是第二次的。v2 的每条记录带
 * HEAD 与 index 里的对象 id(`<hH> <hI>`),暂存内容的任何变化都会改变输出。只读,与 v1 同一条命令。
 *
 * `--branch`:输出以 `# branch.oid <HEAD 的提交>` / `# branch.head <分支>` 开头。条目行只带 HEAD **里的 blob** id:
 * 终端里产生新提交(`git commit --amend --only -m …`、别的工具移动了 HEAD)而已暂存的条目一字不差时,不带
 * 它指纹不变——面板不刷新,提交前的确认(CommitEditor)也看不出 HEAD 已经不是用户看到的那个。
 * `--no-ahead-behind`:带 `--branch` 时 git 默认还要数与上游相差的提交数(大仓库里每个 tick 数一次很贵),
 * 面板不显示它;关掉后那一行只在"相同 / 不同"之间变化。
 * 这条命令的输出只当作不透明的字符串比较,不解析;列表另由 status-scanner 的 v1 命令读出,不受这些头行影响。
 *
 * 不覆盖的:**未暂存的**子模块指针再次前进。status 为子模块条目输出的是 HEAD 与 index 里记录的提交 id 和
 * `S<c><m><u>` 标志,不输出子模块自己当前的 HEAD:` M sub` 的子模块再提交一次,输出一字不差(实测 git 2.50 / 2.56);
 * status 没有能把它打出来的选项(要另起一条 `git diff`),目录的 mtime 也不变(worktreeStamp 看不出)。
 * 只影响 Changes 区那一行显示的 `Subproject commit …`——点一下该行或手动 Refresh 即重读;已暂存的指针在
 * index 里,任何变化都在指纹里(real-git R81),提交的内容不受影响。
 *
 * 不覆盖的:工作树文件的内容(status 不为未暂存的文件输出 id)——同一个未暂存文件再次被编辑时 XY 与 id
 * 都不变。面板为此另外比较当前显示的工作树 diff 的 worktreeStamp(见 diff-fetcher 的 isWorktreeDiffStale)。
 *
 * 时间上限与读列表的那条 status(status-scanner 的 scanStatus)相同:都不另设,用宿主的默认值。此前这里是 5 s——
 * status 要跑更久的仓库(很大的工作树、慢盘)里列表读得出来而指纹永远读不出来:面板照常显示,每次点 Commit
 * 都被拦下并提示"仓库已变化",永远提交不了。
 * 读不到(非零退出 / 超时 / 输出被截断)一律抛错并带原因,绝不返回半截输出冒充指纹(截断点之后的变化比较不出来)。
 * 调用方:main.ts 的 load 把它并入 statusError(面板显示原因、禁用 Commit / Amend、tick 按退避重试);
 * 提交前的确认(CommitEditor)单独说明"无法确认仓库状态"。
 */
export async function readStatusHash(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<string> {
  const result = await gitExec(
    app,
    repoRoot,
    ['status', '--porcelain=v2', '--branch', '--no-ahead-behind', '-z'],
  );
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`git status failed (${failureDetail(result)})`);
  }
  if (result.truncated) throw new Error('git status output was too large');
  return result.stdout;
}
