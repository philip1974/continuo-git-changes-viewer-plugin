import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { loadNumstat, type NumstatEntry } from './numstat';
import { isForgedIndexPath, isSafeRepoRelativePath } from './path-utils';

export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'U';
export type FileKind = 'text' | 'binary';
export type PorcelainStatusCode = ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | '?' | 'U';

export interface FileChange {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: FileStatus;
  readonly statusX: PorcelainStatusCode;
  readonly statusY: PorcelainStatusCode;
  readonly kind: FileKind;
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
    code === 'U'
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

    // 不可信仓库的 index 可以含仓库外 / git 目录内的路径(见 path-utils),一律丢弃,不显示、不可操作。
    if (!isSafeRepoRelativePath(path)) continue;
    if (origPath !== undefined && !isSafeRepoRelativePath(origPath)) continue;

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
    });
  }

  return changes;
}

export async function scanStatus(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<FileChange[]> {
  const status = await gitExec(app, repoRoot, ['status', '--porcelain=v1', '-z']);
  if (status.exitCode !== 0) return [];
  // 输出被宿主的输出上限截断时,最后一条记录可能只有半截(`-z` 下每条以 NUL 结尾):只解析完整记录。
  const stdout = status.truncated
    ? status.stdout.slice(0, status.stdout.lastIndexOf('\0') + 1)
    : status.stdout;
  const forged = forgedPaths(stdout);
  if (forged.length > 0) throw new UnsafeIndexError(forged);
  const numstat = await loadNumstat(app, repoRoot);
  return parsePorcelainStatus(stdout, numstat);
}
