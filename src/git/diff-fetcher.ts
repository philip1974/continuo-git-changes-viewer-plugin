import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { isNotFoundError } from './fs-errors';
import { isSafeRepoRelativePath, UNSAFE_PATH_ERROR } from './path-utils';
import type { FileChange } from './status-scanner';

// v0.1.3 hotfix: MergeView 必须接收两个全文（不是 filter unified diff +/-）。
// `original` = HEAD 版整个文件；`modified` = 当前 working tree 整个文件。
// `unifiedDiff` 保留供 hunk 跳转 / 调试 / placeholder 显示用。
export type DiffResult =
  | {
      ok: true;
      path: string;
      original: string; // HEAD 版全文；新文件为 ""
      modified: string; // working tree 全文；删除文件为 ""
      unifiedDiff: string;
      isUntracked: boolean;
      /** 工作树全文未读取(modified 为 "")的原因;正常读取时不带此字段。 */
      withheld?: WithheldReason;
    }
  | {
      ok: false;
      reason: 'too-large' | 'git-error';
      path: string;
      exactCommand: string;
      message?: string;
    };

/**
 * - symlink:路径或其某级父目录是符号链接。
 * - unverified:无法确认不是符号链接(无 app.fs、scope 错误、路径越出仓库根等)。
 */
export type WithheldReason = 'symlink' | 'unverified';

type DiffApp = Pick<CoPluginApp, 'shell'> & Partial<Pick<CoPluginApp, 'fs'>>;

export type DiffMode = 'changed' | 'staged';

function trackedCommand(path: string, mode: DiffMode): string {
  return mode === 'staged'
    ? `git diff --cached -- ${path}`
    : `git diff -- ${path}`;
}

function untrackedCommand(path: string): string {
  return `git diff --no-index --binary --no-color /dev/null ${path}`;
}

async function gitShowHead(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
): Promise<string> {
  // exit 128 if HEAD doesn't contain the path (new / renamed-to file)
  const r = await gitExec(app, repoRoot, ['show', `HEAD:${path}`]);
  return r.exitCode === 0 ? r.stdout : '';
}

// 读工作树全文(安全):`cat` 会跟随符号链接。来历不明的目录里,被跟踪/未跟踪的路径(或其父目录)
// 可以是指向 workspace 之外的链接(`notes.txt -> ~/.ssh/id_rsa`);git 自身只显示链接目标路径,
// 面板却会把外部文件内容显示出来。因此读取前用 app.fs.lstat(不跟随链接)逐级检查该路径及其在
// repoRoot 之下的每一级父目录:
// - 任一级是符号链接 → 不读('symlink')。
// - 检查做不了(无 app.fs / lstat、scope 错误、EACCES 等)→ 不读('unverified',fail-closed);
//   只有明确的 ENOENT 才算"不是链接"(文件已不存在,cat 本来也读不到)。
// - 路径是绝对路径或含 `..` 段(越出仓库根)→ 不读。
// 检查与读取之间有极小的时间窗(本地攻击者可在其间替换文件),与显示性质的低风险相称,不再加码。
async function checkNoSymlink(
  app: DiffApp,
  repoRoot: string,
  path: string,
): Promise<WithheldReason | null> {
  const fs = app.fs;
  if (!fs || typeof fs.lstat !== 'function') return 'unverified';
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (path.startsWith('/') || segments.length === 0 || segments.includes('..')) {
    return 'unverified';
  }
  const root = repoRoot.replace(/[\\/]+$/, '');
  const levels = segments.map((_, i) => `${root}/${segments.slice(0, i + 1).join('/')}`);
  const results = await Promise.all(
    levels.map(async (level): Promise<WithheldReason | null> => {
      try {
        return (await fs.lstat(level)).isSymlink ? 'symlink' : null;
      } catch (err) {
        return isNotFoundError(err) ? null : 'unverified';
      }
    }),
  );
  if (results.includes('symlink')) return 'symlink';
  return results.includes('unverified') ? 'unverified' : null;
}

type WorktreeRead = { readonly content: string; readonly withheld?: WithheldReason };

async function readWorktreeFile(
  app: DiffApp,
  repoRoot: string,
  path: string,
): Promise<WorktreeRead> {
  const withheld = await checkNoSymlink(app, repoRoot, path);
  if (withheld !== null) return { content: '', withheld };
  const r = await app.shell.exec('cat', [path], { cwd: repoRoot });
  return { content: r.exitCode === 0 ? r.stdout : '' };
}

export async function fetchDiff(
  app: DiffApp,
  repoRoot: string,
  change: FileChange,
  mode: DiffMode = 'changed',
): Promise<DiffResult> {
  const untracked = change.status === 'U';

  // status 解析已丢弃这类条目(见 path-utils);这里是同一检查在读取入口的再次把关,不起任何进程。
  if (!isSafeRepoRelativePath(change.path) || (change.oldPath !== undefined && !isSafeRepoRelativePath(change.oldPath))) {
    return {
      ok: false,
      reason: 'git-error',
      path: change.path,
      exactCommand: trackedCommand(change.path, mode),
      message: UNSAFE_PATH_ERROR,
    };
  }

  // Untracked: 没 HEAD 版；只显示 WT 全文（DiffView 走 NewFileView 分支）
  if (untracked) {
    const wt = await readWorktreeFile(app, repoRoot, change.path);
    return {
      ok: true,
      path: change.path,
      original: '',
      modified: wt.content,
      unifiedDiff: '',
      isUntracked: true,
      ...(wt.withheld ? { withheld: wt.withheld } : {}),
    };
  }

  const exactCommand = trackedCommand(change.path, mode);
  const headPath = change.oldPath ?? change.path; // R<score> 用 oldPath 拿 HEAD 内容
  const diffArgs =
    mode === 'staged'
      ? ['diff', '--cached', '--', change.path]
      : ['diff', '--', change.path];

  // 并发跑 3 个 shell 命令
  const [originalRaw, wt, diffR] = await Promise.all([
    gitShowHead(app, repoRoot, headPath),
    change.status === 'D'
      ? Promise.resolve<WorktreeRead>({ content: '' })
      : readWorktreeFile(app, repoRoot, change.path),
    gitExec(app, repoRoot, diffArgs),
  ]);

  if (diffR.truncated) {
    return {
      ok: false,
      reason: 'too-large',
      path: change.path,
      exactCommand,
    };
  }
  if (diffR.exitCode !== 0) {
    return {
      ok: false,
      reason: 'git-error',
      path: change.path,
      exactCommand,
      message: diffR.stderr || diffR.stdout,
    };
  }

  return {
    ok: true,
    path: change.path,
    original: originalRaw,
    modified: wt.content,
    unifiedDiff: diffR.stdout,
    isUntracked: false,
    ...(wt.withheld ? { withheld: wt.withheld } : {}),
  };
}

// Untracked helper kept for backward compat in spec; not used in runtime.
export { untrackedCommand };
