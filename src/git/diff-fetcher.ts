import type { CoPluginApp, FsStat, PluginShellExecResult } from '../sdk/types';
import { gitExec } from './exec';
import { isNotFoundError } from './fs-errors';
import { isSafeRepoRelativePath, joinRepoPath, UNSAFE_PATH_ERROR } from './path-utils';
import { shellQuotePath } from './shell-quote';
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
      /** 新版文件超过 MAX_FILE_BYTES,或读取超时:modified 只是开头的那一部分。 */
      modifiedTruncated?: true;
      /** modifiedTruncated 的原因是读取超时(FILE_READ_TIMEOUT_MS),不是大小。 */
      modifiedTimedOut?: true;
      /**
       * 新版一侧是**新增的符号链接**(diff 头 `new file mode 120000`):modified 是 git 存的链接目标路径,
       * 不是文件内容。面板据此标注 "Symbolic link → <target>"。
       */
      modifiedIsSymlink?: true;
      /**
       * 读了工作树文件(mode 'changed',且工作树一侧不是删除)时,读取之前该文件的标记,见 readWorktreeStamp;
       * 取不到时不带此字段。
       */
      worktreeStamp?: string;
    }
  | {
      ok: false;
      reason: 'too-large' | 'git-error';
      path: string;
      /** 供用户复制到终端的等价命令(路径已按 shell 规则转义);路径含控制字符时为 null。 */
      exactCommand: string | null;
      message?: string;
    };

/**
 * - symlink:路径或其某级父目录是符号链接。
 * - unverified:无法确认不是符号链接(无 app.fs、scope 错误、路径越出仓库根等)。
 * - not-regular:路径存在但不是普通文件(目录、FIFO、设备、socket)。
 * - no-staged-blob:(仅 staged 模式)index 里这个路径确实没有 stage 0 的 blob——gitlink(子模块 / 嵌套仓库),
 *   或未解决的冲突(只有 stage 1–3)。
 * - staged-unreadable:(仅 staged 模式)index 版本没读出来,且不属于上面两种——被守卫拒绝、进程被终止、
 *   对象读不到等。内容没有显示,但提交照样会包含它。
 */
export type WithheldReason = 'symlink' | 'unverified' | 'not-regular' | 'no-staged-blob' | 'staged-unreadable';

// 读"整个文件"(HEAD 版 blob、工作树全文)的输出上限。不设时用宿主 shell.exec 的默认值(10 MiB,超出部分
// 丢弃并置 truncated)——新文件 / 未跟踪文件的全文直接渲染进一个 <pre>,10 MiB 既卡又没有任何"被截断"的
// 提示。这里显式设 1 MiB:超出时只取开头部分并标记 modifiedTruncated,面板显示 "File too large" 说明。
// unified diff 不在此列:它被截断时整体降级为 "Diff too large" 占位(见 fetchDiff),渲染另有行数上限。
export const MAX_FILE_BYTES = 1024 * 1024;

// 同一类读取的超时。宿主在输出超过上限后只是丢弃多余的输出,不关闭管道、不杀进程(Continuo
// shell.service:写满后切成丢弃式读取,进程照常跑完);不传 timeoutMs 时用宿主默认的 30 s。一个数 GB 的
// 文件、或卡住的文件系统,会让 cat / cat-file 在后台一直读到那时——自动刷新还会反复发起。这里显式设
// 5 s:到时宿主终止整棵进程树(timedOut),已读到的部分照常使用,按"过大"同样处理并说明。
export const FILE_READ_TIMEOUT_MS = 5_000;

const FILE_READ_LIMITS = { maxOutputBytes: MAX_FILE_BYTES, timeoutMs: FILE_READ_TIMEOUT_MS } as const;

type DiffApp = Pick<CoPluginApp, 'shell'> & Partial<Pick<CoPluginApp, 'fs'>>;

export type DiffMode = 'changed' | 'staged';

// "Diff too large" 占位里供用户复制的命令。路径按 shell 规则转义(见 shell-quote);含控制字符的路径没有
// 可安全粘贴的形式 → null(占位里的 Copy 按钮禁用)。
function trackedCommand(path: string, mode: DiffMode): string | null {
  const quoted = shellQuotePath(path);
  if (quoted === null) return null;
  return mode === 'staged'
    ? `git diff --cached -- ${quoted}`
    : `git diff -- ${quoted}`;
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
  // 超过 MAX_FILE_BYTES 或读取超时只拿到开头部分:original 只用来区分"HEAD 里没有这个文件",显示内容来自 unified diff。
  const r = await gitExec(app, repoRoot, ['cat-file', 'blob', `HEAD:${path}`], FILE_READ_LIMITS);
  return r.exitCode === 0 || r.timedOut ? r.stdout : '';
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
): Promise<{ readonly withheld: WithheldReason | null; readonly stamp?: string }> {
  const fs = app.fs;
  if (!fs || typeof fs.lstat !== 'function') return { withheld: 'unverified' };
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (path.startsWith('/') || segments.length === 0 || segments.includes('..')) {
    return { withheld: 'unverified' };
  }
  const root = repoRoot.replace(/[\\/]+$/, '');
  const levels = segments.map((_, i) => `${root}/${segments.slice(0, i + 1).join('/')}`);
  const last = levels.length - 1;
  // 末级的 lstat 顺带给出 worktreeStamp(见 readWorktreeStamp):在读内容之前取——两者之间文件若被改动,
  // 标记是旧的,下一个 tick 判为过期并重读(反过来会漏掉)。
  let stamp: string | undefined;
  const results = await Promise.all(
    levels.map(async (level, i): Promise<WithheldReason | null> => {
      try {
        const st = await fs.lstat(level);
        if (i === last) stamp = stampOf(st);
        if (st.isSymlink) return 'symlink';
        // 只认明确的 isFile === true;宿主没给出该字段也按"不是普通文件"处理(fail-closed)
        return i === last && st.isFile !== true ? 'not-regular' : null;
      } catch (err) {
        if (!isNotFoundError(err)) return 'unverified';
        if (i === last) stamp = MISSING_STAMP;
        return null;
      }
    }),
  );
  const withheld = results.includes('symlink')
    ? 'symlink'
    : results.includes('unverified')
      ? 'unverified'
      : results.includes('not-regular')
        ? 'not-regular'
        : null;
  return { withheld, ...(stamp === undefined ? {} : { stamp }) };
}

const MISSING_STAMP = 'missing';
const stampOf = (st: FsStat): string => `${st.isSymlink ? 'l' : st.isFile === true ? 'f' : 'o'}:${st.size}:${st.mtimeMs}`;

/**
 * 工作树文件的标记:类型 + 大小 + mtime(app.fs.lstat——看链接本身,不跟随、不读内容);文件不存在是 'missing'。
 * 用途:同一个未暂存文件再次被编辑时 status 的 XY 不变,status 指纹(status-hash)看不出来;diff 记下读取时的
 * 标记,自动刷新的 tick 拿它与现在的比较(isWorktreeDiffStale)。取不到(无 app.fs、scope 错误、路径不规范)→
 * undefined:不比较,行为与没有这个标记时相同。
 */
export async function readWorktreeStamp(
  app: DiffApp,
  repoRoot: string,
  path: string,
): Promise<string | undefined> {
  const fs = app.fs;
  const abs = joinRepoPath(repoRoot, path);
  if (!fs || typeof fs.lstat !== 'function' || abs === null) return undefined;
  try {
    return stampOf(await fs.lstat(abs));
  } catch (err) {
    return isNotFoundError(err) ? MISSING_STAMP : undefined;
  }
}

/** 这份(工作树)diff 读取之后文件又变了。没有标记、现在取不到标记、diff 失败或没有 diff → false。 */
export async function isWorktreeDiffStale(
  app: DiffApp,
  repoRoot: string,
  diff: DiffResult | null | undefined,
): Promise<boolean> {
  if (!diff || !diff.ok || diff.worktreeStamp === undefined) return false;
  const now = await readWorktreeStamp(app, repoRoot, diff.path);
  return now !== undefined && now !== diff.worktreeStamp;
}

type FileRead = {
  readonly content: string;
  /** 读工作树文件时顺带取得的 worktreeStamp。 */
  readonly stamp?: string;
  readonly withheld?: WithheldReason;
  readonly truncated?: boolean;
  readonly timedOut?: boolean;
};

const readFlags = (wt: FileRead) => ({
  ...(wt.withheld ? { withheld: wt.withheld } : {}),
  ...(wt.truncated ? { modifiedTruncated: true as const } : {}),
  ...(wt.timedOut ? { modifiedTimedOut: true as const } : {}),
  ...(wt.stamp === undefined ? {} : { worktreeStamp: wt.stamp }),
});

// 整文件读取的结果 → 内容。超过大小上限(truncated:宿主丢弃了多余的输出,进程通常仍以 0 退出)与超时
// (timedOut:宿主终止了进程,没有退出码)都只拿到开头的一部分,照常使用并标记;其余失败返回 null。
function partialOrWhole(r: PluginShellExecResult): FileRead | null {
  if (r.timedOut) return { content: r.stdout, truncated: true, timedOut: true };
  if (r.truncated) return { content: r.stdout, truncated: true };
  return r.exitCode === 0 ? { content: r.stdout } : null;
}

async function readWorktreeFile(
  app: DiffApp,
  repoRoot: string,
  path: string,
): Promise<FileRead> {
  const { withheld, stamp } = await checkReadable(app, repoRoot, path);
  const stamped = stamp === undefined ? {} : { stamp };
  if (withheld !== null) return { content: '', withheld, ...stamped };
  // `--`:文件名可以以 `-` 开头(`-n`、`--help`),不能被 cat 当成选项
  const r = await app.shell.exec('cat', ['--', path], { cwd: repoRoot, ...FILE_READ_LIMITS });
  return { ...(partialOrWhole(r) ?? { content: '' }), ...stamped };
}

// 读 index 里的版本(Staged 区显示的"将要提交的内容")。此前 staged 模式也读工作树:`git add n.txt` 之后
// 再改 n.txt(状态 `AM`),Staged 区显示的是改后的内容而提交的是暂存时的内容;暂存后删掉文件(`AD`)
// 则显示 "(empty file)"。
// - `:0:<path>`,不是 `:<path>`:git 把 `:<0-3>:<rest>` 解析成"stage N 的 <rest>",名为 `0:x` 的文件写成
//   `:0:x` 读到的是 `x`;显式带上 stage 后冒号之后整体是路径(real-git R62)。参数以 `:` 开头,不会被当成选项。
// - 读的是对象库里的 blob,不经过工作树:不需要符号链接检查(暂存的符号链接得到的是 git 存的目标路径文本)。
// - cat-file 失败 → 不显示内容,原因见 stagedReadFailure。
async function readIndexBlob(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  change: FileChange,
): Promise<FileRead> {
  const r = await gitExec(app, repoRoot, ['cat-file', 'blob', `:0:${change.path}`], FILE_READ_LIMITS);
  return partialOrWhole(r) ?? { content: '', withheld: await stagedReadFailure(app, repoRoot, change) };
}

/** status 的 XY 表示未合并(git-status(1) 的 unmerged 表:DD AU UD UA DU AA UU)。 */
function isUnmerged(change: FileChange): boolean {
  const { statusX: x, statusY: y } = change;
  return x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
}

// index 版本没读出来的原因。此前一律说成"子模块或未解决的冲突"——被守卫拒绝、进程起不来、退出码 128
// 也都这么显示,把读取失败说成了仓库的状态。只有确认是下面两种才用 'no-staged-blob':
// - 未合并:status 已经给出(不再起命令);
// - `ls-files -s -z -- <path>` 里该路径的记录是 gitlink(mode 160000)或只有 stage 1–3。
// 其余(含 ls-files 本身失败 / 超时 / 输出不完整 / 没有这条记录)一律 'staged-unreadable'。
// ls-files -s 只读 index:不刷新、不碰工作树、不起子进程。只在读取失败后才运行。
async function stagedReadFailure(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  change: FileChange,
): Promise<WithheldReason> {
  if (isUnmerged(change)) return 'no-staged-blob';
  const r = await gitExec(app, repoRoot, ['ls-files', '-s', '-z', '--', change.path], { timeoutMs: FILE_READ_TIMEOUT_MS });
  if (r.exitCode !== 0 || r.timedOut || r.truncated) return 'staged-unreadable';
  // 每条记录:`<mode> <oid> <stage>\t<path>`。只看这个路径自己的记录(路径是目录前缀时会列出其下的条目)。
  const own = r.stdout
    .split('\0')
    .map((record) => /^(\d{6}) [0-9a-f]+ ([0-3])\t([\s\S]*)$/.exec(record))
    .filter((m): m is RegExpExecArray => m !== null && m[3] === change.path);
  const noBlob = own.some((m) => m[1] === GITLINK_MODE || m[2] !== '0');
  return noBlob ? 'no-staged-blob' : 'staged-unreadable';
}

const GITLINK_MODE = '160000';

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
    // 新版一侧没有文件:staged 看 index 一侧(X),changed 看工作树一侧(Y)。不能看合并后的 status:
    // `AD` 合并成 A、`RD` 合并成 R,工作树一侧其实是删除。
    (mode === 'staged' ? change.statusX === 'D' : change.statusY === 'D')
      ? Promise.resolve<FileRead>({ content: '' })
      : mode === 'staged'
        ? readIndexBlob(app, repoRoot, change)
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
    ...(addsSymlink(diffR.stdout) ? { modifiedIsSymlink: true as const } : {}),
  };
}

const SYMLINK_MODE = '120000';

// diff 头(第一个 hunk 之前的扩展头)里有 `new file mode 120000`:这一侧新增的是符号链接。
// 只看 `@@` / `---` 之前的行——文件内容里出现同样的文字不算;文件名进不了这些行(含换行的名字被 git 加引号)。
function addsSymlink(unifiedDiff: string): boolean {
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('--- ')) return false;
    if (line === `new file mode ${SYMLINK_MODE}`) return true;
  }
  return false;
}
