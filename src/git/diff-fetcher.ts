import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { isNotFoundError } from './fs-errors';
import { isSafeRepoRelativePath, UNSAFE_PATH_ERROR } from './path-utils';
import type { FileChange } from './status-scanner';

// v0.1.3 hotfix: MergeView 必须接收两个全文（不是 filter unified diff +/-）。
// `original` = HEAD 版整个文件；`modified` = 新版整个文件——Changes 区(mode 'changed')是工作树文件,
// Staged 区(mode 'staged')是 index 里的版本(将要提交的内容),不是工作树。
// `unifiedDiff` 保留供 hunk 跳转 / 调试 / placeholder 显示用。
export type DiffResult =
  | {
      ok: true;
      path: string;
      original: string; // HEAD 版全文；新文件为 ""
      modified: string; // 新版全文(changed:工作树;staged:index);删除文件为 ""
      unifiedDiff: string;
      isUntracked: boolean;
      /** 新版全文未读取(modified 为 "")的原因;正常读取时不带此字段。 */
      withheld?: WithheldReason;
      /** 新版文件超过 MAX_FILE_BYTES:modified 只是开头的那一部分。 */
      modifiedTruncated?: true;
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
 * - not-regular:路径存在但不是普通文件(目录、FIFO、设备、socket)。
 * - no-staged-blob:(仅 staged 模式)index 里这个路径没有 stage 0 的 blob——gitlink(子模块 / 嵌套仓库)、
 *   未解决的冲突(只有 stage 1–3),或读取失败。
 */
export type WithheldReason = 'symlink' | 'unverified' | 'not-regular' | 'no-staged-blob';

// 读"整个文件"(HEAD 版 blob、工作树全文)的输出上限。不设时用宿主 shell.exec 的默认值(10 MiB,超出部分
// 丢弃并置 truncated)——新文件 / 未跟踪文件的全文直接渲染进一个 <pre>,10 MiB 既卡又没有任何"被截断"的
// 提示。这里显式设 1 MiB:超出时只取开头部分并标记 modifiedTruncated,面板显示 "File too large" 说明。
// unified diff 不在此列:它被截断时整体降级为 "Diff too large" 占位(见 fetchDiff),渲染另有行数上限。
export const MAX_FILE_BYTES = 1024 * 1024;

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
  // `cat-file blob`,不是 `show`:`git show HEAD:a..b` 先把整个参数按 `..` / `...` 拆成修订区间
  // (存在路径 `a` 与分支 `b` 时成立),输出的是提交日志而不是文件内容(实测 git 2.50 / 2.56)。
  // cat-file 把参数当作单个对象名,`<rev>:<path>` 冒号后整体是路径:文件名含 `..`、`@{`、`^`、`~`、
  // `:`、以 `-` 开头都按字面解析(real-git R50);不是 blob(目录、gitlink)时报错而不是列出 tree。
  // 不做 textconv / filter 转换(那需要 --textconv / --filters)。
  // exit 128 if HEAD doesn't contain the path (new / renamed-to file)
  // 超过 MAX_FILE_BYTES 时只拿到开头部分:original 只用来区分"HEAD 里没有这个文件",显示内容来自 unified diff。
  const r = await gitExec(app, repoRoot, ['cat-file', 'blob', `HEAD:${path}`], { maxOutputBytes: MAX_FILE_BYTES });
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
// - 路径本身存在但不是普通文件 → 不读('not-regular'):`cat` 一个 FIFO 会一直阻塞到宿主的超时
//   (自动刷新会反复发起),字符设备(/dev/zero 的硬链接等)会无限输出。
// 检查与读取之间有极小的时间窗(本地攻击者可在其间替换文件),与显示性质的低风险相称,不再加码。
async function checkReadable(
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
  const last = levels.length - 1;
  const results = await Promise.all(
    levels.map(async (level, i): Promise<WithheldReason | null> => {
      try {
        const st = await fs.lstat(level);
        if (st.isSymlink) return 'symlink';
        // 只认明确的 isFile === true;宿主没给出该字段也按"不是普通文件"处理(fail-closed)
        return i === last && st.isFile !== true ? 'not-regular' : null;
      } catch (err) {
        return isNotFoundError(err) ? null : 'unverified';
      }
    }),
  );
  if (results.includes('symlink')) return 'symlink';
  if (results.includes('unverified')) return 'unverified';
  return results.includes('not-regular') ? 'not-regular' : null;
}

type FileRead = { readonly content: string; readonly withheld?: WithheldReason; readonly truncated?: boolean };

const readFlags = (wt: FileRead) => ({
  ...(wt.withheld ? { withheld: wt.withheld } : {}),
  ...(wt.truncated ? { modifiedTruncated: true as const } : {}),
});

async function readWorktreeFile(
  app: DiffApp,
  repoRoot: string,
  path: string,
): Promise<FileRead> {
  const withheld = await checkReadable(app, repoRoot, path);
  if (withheld !== null) return { content: '', withheld };
  // `--`:文件名可以以 `-` 开头(`-n`、`--help`),不能被 cat 当成选项
  const r = await app.shell.exec('cat', ['--', path], { cwd: repoRoot, maxOutputBytes: MAX_FILE_BYTES });
  // 被截断时 cat 可能因写端关闭而以非 0 / 信号结束:已读到的开头部分照常使用
  if (r.truncated) return { content: r.stdout, truncated: true };
  return { content: r.exitCode === 0 ? r.stdout : '' };
}

// 读 index 里的版本(Staged 区显示的"将要提交的内容")。此前 staged 模式也读工作树:`git add n.txt` 之后
// 再改 n.txt(状态 `AM`),Staged 区显示的是改后的内容而提交的是暂存时的内容;暂存后删掉文件(`AD`)
// 则显示 "(empty file)"。
// - `:0:<path>`,不是 `:<path>`:git 把 `:<0-3>:<rest>` 解析成"stage N 的 <rest>",名为 `0:x` 的文件写成
//   `:0:x` 读到的是 `x`;显式带上 stage 后冒号之后整体是路径(real-git R62)。参数以 `:` 开头,不会被当成选项。
// - 读的是对象库里的 blob,不经过工作树:不需要符号链接检查(暂存的符号链接得到的是 git 存的目标路径文本)。
// - 没有 stage 0 的 blob(gitlink、未解决的冲突)→ cat-file 失败 → 'no-staged-blob'。
async function readIndexBlob(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
): Promise<FileRead> {
  const r = await gitExec(app, repoRoot, ['cat-file', 'blob', `:0:${path}`], { maxOutputBytes: MAX_FILE_BYTES });
  if (r.truncated) return { content: r.stdout, truncated: true };
  return r.exitCode === 0 ? { content: r.stdout } : { content: '', withheld: 'no-staged-blob' };
}

export async function fetchDiff(
  app: DiffApp,
  repoRoot: string,
  change: FileChange,
  mode: DiffMode = 'changed',
): Promise<DiffResult> {
  const untracked = change.status === 'U';

  // 这类条目在列表里是不可操作行(FileChange.inoperable,不可选中)或已被丢弃(伪造,见 path-utils);
  // 这里是同一检查在读取入口的再次把关,不起任何进程。
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
      ...readFlags(wt),
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
    // 新版一侧没有文件:staged 看 index 一侧(X),changed 看工作树一侧(合并后的 status;`AD` 的 status 是 A,
    // 工作树读取得到 ENOENT → 空)
    (mode === 'staged' ? change.statusX === 'D' : change.status === 'D')
      ? Promise.resolve<FileRead>({ content: '' })
      : mode === 'staged'
        ? readIndexBlob(app, repoRoot, change.path)
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
    ...readFlags(wt),
  };
}

// Untracked helper kept for backward compat in spec; not used in runtime.
export { untrackedCommand };
