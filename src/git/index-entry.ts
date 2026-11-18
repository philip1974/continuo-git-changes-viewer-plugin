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
