import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { loadNumstat, type NumstatEntry } from './numstat';
import { isForgedIndexPath, isSafeRepoRelativePath } from './path-utils';

export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'U';
export type FileKind = 'text' | 'binary';
// `T`:类型变更(普通文件 ↔ 符号链接 ↔ 子模块)。必须原样保留:它的 diff 是"删除 + 新增"两段,不能按 hunk
// 拆(见 hunk-patch 的 isHunkPatchableDiff);归一成 `M` 会让 hunk 操作对它放开。显示上仍算修改(FileStatus 'M')。
export type PorcelainStatusCode = ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | '?' | 'U' | 'T';

export interface FileChange {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: FileStatus;
  readonly statusX: PorcelainStatusCode;
  readonly statusY: PorcelainStatusCode;
  readonly kind: FileKind;
  /**
   * 路径(或重命名 / 复制的原路径)不是 isSafeRepoRelativePath 认可的形式,但也不是伪造 index 的证据——
   * POSIX 上合法的名字 `c:notes.txt`、`..\x`。这一行只用于显示(路径当作文本):不可选中、不可
   * stage / unstage / discard、不读 diff,路径不进入任何 git / cat 参数。见 parsePorcelainStatus。
   */
  readonly inoperable?: true;
}

export function deriveFileStatus(change: FileChange): FileStatus {
  return statusFromCode(`${change.statusX}${change.statusY}`);
}

function normalizeStatusCode(code: string): PorcelainStatusCode {
  if (
    code === ' ' ||
    code === 'M' ||
    code === 'A' ||
    code === 'D' ||
    code === 'R' ||
    code === 'C' ||
    code === '?' ||
    code === 'U' ||
    code === 'T'
  ) {
    return code;
  }
  return 'M';
}

function statusFromCode(code: string): FileStatus {
  if (code === '??') return 'U';
  if (code[0] === 'R' || code[1] === 'R') return 'R';
  if (code[0] === 'A' || code[1] === 'A') return 'A';
  if (code[0] === 'D' || code[1] === 'D') return 'D';
  return 'M';
}

function kindFor(path: string, numstat: Map<string, NumstatEntry>): FileKind {
  return numstat.get(path)?.isBinary ? 'binary' : 'text';
}

/** porcelain v1 -z 里重命名(R)与复制(C)记录后面都跟着一条"原路径"。 */
function hasOrigPath(code: string): boolean {
  return /[RC]/.test(code.slice(0, 2));
}

/**
 * status 列出了 git 自己绝不会记录的路径(`../x`、绝对路径、`.git/...`):index 是伪造的。
 * 只把这些条目从列表里丢掉不够——已暂存的那些仍会被 `commit` 写进 tree,而用户在面板里看不到它们。
 * 正常的 git 不会产生这样的 index,所以整个仓库按受限处理(main.ts 捕获后交给 RepoSafetyGuard.restrict)。
 */
export class UnsafeIndexError extends Error {
  constructor(readonly paths: readonly string[]) {
    const shown = paths.slice(0, 3).join(', ');
    const more = paths.length > 3 ? ` and ${paths.length - 3} more` : '';
    super(
      `Git commands are disabled for this repository: its index lists paths that are outside this folder ` +
        `or inside the git directory (${shown}${more}). Git never records such paths itself, and a commit ` +
        `would include them. For safety the viewer does not run git here. You can still use git in a terminal.`,
    );
    this.name = 'UnsafeIndexError';
  }
}

/** status 输出里被判为伪造的路径(含重命名 / 复制记录的原路径),按出现顺序。 */
function forgedPaths(stdout: string): string[] {
  const parts = stdout.split('\0').filter((part) => part.length > 0);
  const found: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]!;
    const candidates = [record.slice(3)];
    if (hasOrigPath(record.slice(0, 2)) && i + 1 < parts.length) candidates.push(parts[++i]!);
    for (const path of candidates) if (isForgedIndexPath(path)) found.push(path);
  }
  return found;
}

export function parsePorcelainStatus(
  stdout: string,
  numstat: Map<string, NumstatEntry> = new Map(),
): FileChange[] {
  const parts = stdout.split('\0').filter((part) => part.length > 0);
  const changes: FileChange[] = [];

  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]!;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    const status = statusFromCode(code);
    const statusX = normalizeStatusCode(code[0] ?? ' ');
    const statusY = normalizeStatusCode(code[1] ?? ' ');
    // 原路径必须在这里吞掉:否则它会被当成下一条记录(`C  copy\0/etc/passwd\0` → 伪条目)。
    const origPath = hasOrigPath(code) ? parts[++i] : undefined;

    // 不可信仓库的 index 可以含仓库外 / git 目录内的路径(见 path-utils):git 自己绝不会记录的那些(伪造)
    // 一律丢弃——scanStatus 遇到它们会整体拒绝(UnsafeIndexError),这里只是解析器单独使用时的兜底。
    if (path === '' || isForgedIndexPath(path)) continue;
    if (origPath !== undefined && isForgedIndexPath(origPath)) continue;
    // 其余不满足 isSafeRepoRelativePath 的名字(`c:notes.txt`、`..\x`:POSIX 上合法,git 会正常记录)不能丢:
    // 它们若已暂存,`commit -F -` 照样把它们提交,而用户在面板里看不到。保留为不可操作行(只显示)。
    const inoperable = !isSafeRepoRelativePath(path) || (origPath !== undefined && !isSafeRepoRelativePath(origPath));

    // 复制(仅 status.renames=copies 时出现;插件已固定 renames=true)按新增文件显示,不带 oldPath:
    // 原文件仍在,HEAD 里没有新路径的版本。
    const oldPath = status === 'R' ? origPath : undefined;
    changes.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      status: status === 'M' && (code[0] === 'C' || code[1] === 'C') ? 'A' : status,
      statusX,
      statusY,
      kind: kindFor(path, numstat),
      ...(inoperable ? { inoperable: true as const } : {}),
    });
  }

  return changes;
}

/**
 * `git status` 没有给出完整、可信的列表:非零退出(index 损坏、被守卫拒绝 ...)、超时,或输出被宿主的
 * 输出上限截断。此前这些情况静默返回空 / 残缺列表——面板看起来像"没有改动",而 Amend 不看暂存数,
 * 仍可提交用户看不到的暂存内容。调用方(main.ts)据此显示错误并禁用 Commit / Amend。
 * `partial`:输出被截断时已完整读到的那部分记录(仅供显示);失败 / 超时时为空。
 */
export class StatusUnavailableError extends Error {
  constructor(
    message: string,
    readonly partial: readonly FileChange[] = [],
  ) {
    super(message);
    this.name = 'StatusUnavailableError';
  }
}

const MAX_FAILURE_DETAIL = 200;

function failureDetail(result: { exitCode: number | null; stderr: string; timedOut: boolean }): string {
  if (result.timedOut) return 'timed out';
  const line = result.stderr.split('\n').find((l) => l.trim() !== '')?.trim();
  if (!line) return `exit ${result.exitCode ?? 'unknown'}`;
  return line.length > MAX_FAILURE_DETAIL ? `${line.slice(0, MAX_FAILURE_DETAIL)}…` : line;
}

/**
 * 完整的 status 列表。拿不到完整列表时抛错,绝不返回空列表冒充"没有改动":
 * - UnsafeIndexError:index 是伪造的(见上);
 * - StatusUnavailableError:命令失败 / 超时 / 输出被截断。
 */
export async function scanStatus(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<FileChange[]> {
  const status = await gitExec(app, repoRoot, ['status', '--porcelain=v1', '-z']);
  if (status.exitCode !== 0 || status.timedOut) {
    throw new StatusUnavailableError(`git status failed (${failureDetail(status)})`);
  }
  // 输出被宿主的输出上限截断时,最后一条记录可能只有半截(`-z` 下每条以 NUL 结尾):只解析完整记录。
  const stdout = status.truncated
    ? status.stdout.slice(0, status.stdout.lastIndexOf('\0') + 1)
    : status.stdout;
  const forged = forgedPaths(stdout);
  if (forged.length > 0) throw new UnsafeIndexError(forged);
  const numstat = await loadNumstat(app, repoRoot);
  const changes = parsePorcelainStatus(stdout, numstat);
  if (status.truncated) {
    throw new StatusUnavailableError('git status output was too large; the list of changes is incomplete', changes);
  }
  return changes;
}
