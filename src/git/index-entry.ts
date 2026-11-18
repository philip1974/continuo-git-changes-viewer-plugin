import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';

export const GITLINK_MODE = '160000';

export interface IndexEntry {
  readonly mode: string;
  /** 0:正常条目;1–3:未解决冲突的各方。 */
  readonly stage: string;
}

/**
 * index 里**这个路径自己**的记录(`ls-files -s -z -- <path>`;路径是目录前缀时 git 会列出其下的条目,
 * 这里只留路径完全相同的)。只读 index:不刷新、不碰工作树、不起子进程。
 * 命令失败 / 超时 / 输出不完整 → null(不知道),与"没有记录"([])区分。
 */
export async function readIndexEntries(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
  timeoutMs: number,
): Promise<IndexEntry[] | null> {
  const r = await gitExec(app, repoRoot, ['ls-files', '-s', '-z', '--', path], { timeoutMs });
  if (r.exitCode !== 0 || r.timedOut || r.truncated) return null;
  // 每条记录:`<mode> <oid> <stage>\t<path>`
  return r.stdout
    .split('\0')
    .map((record) => /^(\d{6}) [0-9a-f]+ ([0-3])\t([\s\S]*)$/.exec(record))
    .filter((m): m is RegExpExecArray => m !== null && m[3] === path)
    .map((m) => ({ mode: m[1]!, stage: m[2]! }));
}

/**
 * index 里有没有位于 `<path>/` 之下的条目(任何 stage)。`git restore --staged -- x` / `git reset HEAD -- x` /
 * `git checkout -- x` 把路径当前缀:x 自己的条目之外,`x/…` 的条目也一并被处理。
 * 命令失败 / 超时 / 输出不完整 → null(不知道)。
 */
export async function hasIndexEntriesInside(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
  timeoutMs: number,
): Promise<boolean | null> {
  const r = await gitExec(app, repoRoot, ['ls-files', '-s', '-z', '--', path], { timeoutMs });
  if (r.exitCode !== 0 || r.timedOut || r.truncated) return null;
  const prefix = `${path.replace(/\/+$/, '')}/`;
  return r.stdout
    .split('\0')
    .some((record) => record.slice(record.indexOf('\t') + 1).startsWith(prefix) && record.includes('\t'));
}

/**
 * `git add -- <path>` 会不会把 `<path>/` 之下的东西加进 index:列出该目录里 git 认为"未跟踪、未被忽略"的条目
 * (`ls-files -o --exclude-standard -z -- <path>`,与 `git add` 用同一套读目录 / 忽略规则)。
 * - 普通目录(含里面有个不是仓库的 `.git` 的目录):列出其中的文件 → true;
 * - 目录里的子目录是嵌套仓库:列出 `<path>/<子目录>/` → true(add 会把它记成 gitlink);
 * - 目录本身是嵌套仓库(add 把 `<path>` 记成一个 gitlink,不进入其中)、空目录、只有被忽略的文件:
 *   没有 `<path>/…` 的记录 → false。
 * 为什么不用 `git add -n`:dry-run 不写 index、不写对象,但照样对每个将要加入的文件运行 clean filter
 * (实测 git 2.50 / 2.56:用户全局配置的 filter 每个文件执行一次),输出也没有 `-z`(文件名里的换行可以伪造行)。
 * 这条命令只读目录:不读文件内容、不运行 filter、不写任何东西。
 * 已经读到一条就足以判 true(哪怕输出随后被截断 / 超时);否则命令失败 / 超时 / 输出不完整 → null(不知道)。
 */
export async function wouldAddEntriesInside(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
  timeoutMs: number,
): Promise<boolean | null> {
  const r = await gitExec(app, repoRoot, ['ls-files', '-o', '--exclude-standard', '-z', '--', path], { timeoutMs });
  const prefix = `${path.replace(/\/+$/, '')}/`;
  // (被截断时最后一段可能只有半截——`<path>/` 加上至少一个字符,同样是证据)
  if (r.stdout.split('\0').some((record) => record.startsWith(prefix) && record.length > prefix.length)) return true;
  return r.exitCode === 0 && !r.timedOut && !r.truncated ? false : null;
}

