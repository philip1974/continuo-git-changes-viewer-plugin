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

// 只要第一条记录:见 findIndexEntryAtAncestor
const FIRST_RECORD_BYTES = 64 * 1024;

/**
 * 路径的某一级**祖先**在 index 里是不是一个条目(文件 / 链接 / 子模块;任何 stage)。是 → 返回那一级的路径
 * (最浅的一级);都不是 → false;查不了 → null。
 *
 * 为什么需要:index 里不能同时有 `x` 与 `x/…`。把 `x/a` 写进 index 的命令(`restore --staged -- x/a`、
 * `reset HEAD -- x/a` 从 HEAD 取回它;`add -- x/a` 新加它)会先把 `x` 这个条目拿掉——用户点的是 `x/a` 那一行,
 * `x` 那一行暂存的内容随之消失(实测 git 2.50 / 2.56)。
 *
 * 每一级祖先一条 `ls-files -s -z -- <祖先>`:祖先通常是目录,git 会列出其下的全部条目(可以很多)。index 按路径
 * 的字节序排列,`x` 自己的记录排在一切 `x/…` 之前、且 pathspec `x` 不匹配 `x.txt` / `x-y`——所以**第一条**记录
 * 的路径是不是恰好等于祖先就是答案,其余输出不需要:输出上限设得很小,被截断不算失败。
 */
export async function findIndexEntryAtAncestor(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
  timeoutMs: number,
): Promise<string | false | null> {
  const segments = path.split('/').filter((segment) => segment !== '');
  const ancestors = segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join('/'));
  const found = await Promise.all(
    ancestors.map(async (ancestor): Promise<boolean | null> => {
      const r = await gitExec(app, repoRoot, ['ls-files', '-s', '-z', '--', ancestor], {
        timeoutMs,
        maxOutputBytes: FIRST_RECORD_BYTES,
      });
      if (r.exitCode !== 0 || r.timedOut) return null;
      const end = r.stdout.indexOf('\0');
      // 没有一条完整的记录:没有输出 = 没有条目;否则是半截(路径比上限还长)= 不知道
      if (end < 0) return r.stdout === '' && !r.truncated ? false : null;
      const m = /^\d{6} [0-9a-f]+ [0-3]\t([\s\S]*)$/.exec(r.stdout.slice(0, end));
      return m ? m[1] === ancestor : null;
    }),
  );
  const hit = found.indexOf(true);
  if (hit >= 0) return ancestors[hit]!;
  return found.includes(null) ? null : false;
}

/**
 * HEAD 里这个路径是不是一个目录(tree)。是 → true;不是(文件 / 不存在)或还没有任何提交 → false;查不了 → null。
 * `restore --staged -- x` / `reset HEAD -- x` 把 HEAD 里 `x/…` 的条目一并取回 index(见 unstage-file)。
 */
export async function isDirectoryInHead(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
  timeoutMs: number,
): Promise<boolean | null> {
  const r = await gitExec(app, repoRoot, ['ls-tree', '-z', 'HEAD', '--', path], { timeoutMs });
  if (r.exitCode === 0 && !r.timedOut && !r.truncated) {
    // 每条记录:`<mode> <type> <oid>\t<path>`;不带 -r 时目录只列出它自己这一条
    return r.stdout.split('\0').some((record) => /^040000 tree [0-9a-f]+\t/.test(record));
  }
  if (r.timedOut) return null;
  // 失败:还没有提交(HEAD 解析不了)时 HEAD 里什么都没有。`--quiet --verify` 对"不是有效对象"以 1 退出、不输出;
  // 别的失败(被守卫拒绝是 128、超时)都不是 1。
  const head = await gitExec(app, repoRoot, ['rev-parse', '--quiet', '--verify', 'HEAD^{commit}'], { timeoutMs });
  return head.exitCode === 1 && !head.timedOut ? false : null;
}
