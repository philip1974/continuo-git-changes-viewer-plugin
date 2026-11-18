import type { CoPluginApp } from '../sdk/types';
import { gitExecUnguarded, registerGitGuard } from './exec';
import { isNotFoundError } from './fs-errors';

// 受限仓库检测(安全):打开一个含攻击者控制 .git 的目录(解压包 / 共享盘)时,仓库可以用两类手段
// 伤害用户;在运行任何 git 命令前先探测,命中任一即进入受限状态,不再运行任何 git 命令(fail-closed)。
//
// 一、执行类:git 按仓库 local config 执行外部程序——filter.<drv>.clean 在 `git status` 重新哈希时
//    就会运行,且 git 没有全局关闭 filter 的开关。
// 二、重定向类:不执行程序,但让 git 把工作树 / git 目录 / 对象库解析到 workspace 之外(实测 git 2.50,
//    见 __tests__/repo-safety-real-git R16–R30):
//    - `core.worktree=/外部目录`:status / diff 把外部文件内容当作改动显示,discard / stage 读写外部文件。
//    - `.git` 是 gitfile(`gitdir: /别人的仓库/.git`)或符号链接、或 `.git/commondir` 指向外部:
//      diff / log 显示另一个(私有)仓库的文件与提交信息。
//    - `.git` 内的符号链接:`index -> 外部 index`(泄露 + stage 改写外部文件)、`refs/heads/x -> 外部 ref`
//      加 `objects/xx -> 外部对象目录` 或 `objects/info/alternates`(引用外部私有对象)、
//      `logs/HEAD -> ~/.zshrc`(commit 把含仓库 user.name 的 reflog 行追加进外部文件)。
//
// 探测分三步,前一步受限就不做后一步:
// 1. 配置:`git config --list --show-scope --includes -z` 只读配置文件,不执行任何程序
//    (实测:恶意 filter/textconv/diff.external/fsmonitor/gpg.program 均不触发)。只看仓库作用域
//    (local / worktree,含 include / includeIf 引入的文件);全局 / 系统 config 是用户自己的,可信。
//    命中执行类键(UNSAFE_KEY_PATTERNS)或重定向类键(core.worktree、非 false 的 core.bare)即受限。
// 2. 布局(纵深,不依赖键列表):一次 `git rev-parse`(见 LAYOUT_PROBE_ARGS)向 git 自己询问
//    "cwd 是否就是工作树顶层"以及 git 目录 / common 目录的绝对路径,要求:
//    - `--is-inside-work-tree` 为 true 且 `--show-prefix` 为空 ⇒ git 认定的工作树顶层就是 cwd(workspace 根)。
//      这是 git 自己做的路径比较,不受 /tmp→/private/tmp、大小写不敏感文件系统影响;不拿 workspace 根
//      字符串去和 `--show-toplevel` 比(两者规范化方式不同会误判)。
//    - git 目录与 common 目录都位于 `--show-toplevel` 之内(三个路径都由 git 以同一方式规范化、
//      解析过符号链接,前缀比较可靠)。合法的 linked worktree / submodule(git 目录在 workspace 外的
//      主仓库里)因此也会受限——插件无法区分"用户自己的主仓库"与"压缩包指向受害者另一个私有仓库",
//      这是有意的安全取舍,提示文案说明原因。
//    输出只按换行切成固定 6 段,多一段少一段(路径含换行、git < 2.31 不认 --path-format)一律受限。
//    cwd 不在任何仓库里(`fatal: not a git repository`)不算受限:没有仓库可保护,后续 git 命令同样只会失败。
// 3. git 目录内的符号链接(经宿主 app.fs.listDir / lstat,不起进程):git 目录与 common 目录的顶层条目、
//    以及 refs / logs / info / reftable 全树、objects 顶层(含 fan-out 目录)、objects/info、objects/pack
//    中出现任何符号链接即受限;非空的 objects/info/alternates 即受限。例外:顶层 `hooks`(常见做法,
//    由 repo-hooks 在提交前处理)。不遍历 objects/xx 内部(要链接到具体对象须已知其 OID)、modules / lfs
//    等 git 核心不经手的目录。app.fs 不可用 / 未授权 / 读取失败 → 受限。
//
// 未列入的可执行键及原因(已用其它方式中和):
// - core.pager / pager.*:全局 `--no-pager`。
// - core.editor / sequence.editor:env GIT_EDITOR=':'。
// - diff.external:另加 `--no-ext-diff`(本列表仍检测,双保险)。
// - core.sshCommand / credential.* / url.* / http.* / remote.*.url 等传输类:只在联网时执行,而每次调用
//   (含未经 hooks 确认的 commit——提交摘要读缺失 blob 也会触发 partial clone 惰性拉取)都以
//   `-c protocol.allow=never` + GIT_NO_LAZY_FETCH=1 + GIT_ALLOW_PROTOCOL= 断网;per-repo sshCommand /
//   credential.helper 是常见的合法配置,检测会误伤。
// - extensions.partialClone / remote.*.promisor / remote.*.partialCloneFilter:blobless / treeless clone 在
//   大仓库里很常见,不列入受限键;靠上面的断网保证不拉取(缺失对象的 diff 显示 git 的报错)。
// - core.hooksPath / .git/hooks:不在此受限检测。hooks 并非只在 commit 时运行——写 index 的
//   add / apply --cached / restore / reset 会触发 post-index-change,checkout / restore 触发
//   post-checkout。中和方式:除 commit 外每次调用都 `-c core.hooksPath=/dev/null`(见 exec.ts),
//   插件的 stage / unstage / discard / 刷新不运行任何 hook;commit 照常运行用户 hooks,但提交前
//   由 repo-hooks 检测仓库 hooks / local core.hooksPath 并要求用户再次确认。husky 等工具普遍设置
//   local core.hooksPath,因此不把它列为受限键(否则会误伤正常仓库)。
//
// 评估后不列入的"指向外部文件"的键(实测不泄露内容、不越界读写,见 R30):
// - core.excludesFile / core.attributesFile / diff.orderFile / mailmap.file:只按模式 / 映射解析,
//   内容不出现在 stdout / stderr(attributes 要执行程序仍需 filter.* / diff.* 键,已检测)。
// - commit.template:插件用 `commit -F -`,不读模板。
// - core.symlinks / core.fileMode:工作树里的符号链接只显示链接目标路径,不跟随。
// - core.sparseCheckout / index.sparse / core.splitIndex / status.showUntrackedFiles:只影响工作树内的呈现。
// - gc.* / maintenance.*:status / diff / add 不触发 gc;commit 之后的自动维护已由
//   `-c maintenance.auto=false -c gc.auto=0` 关闭(见 exec.ts)。gc.recentObjectsHook 按文档会执行命令,
//   仍列入执行类键(双保险)。
// - safe.directory:git 只在受保护作用域(system / global / command)认它,local 无效。
// - core.repositoryFormatVersion 异常值 / 未知 extensions:git 直接拒绝该仓库,所有命令失败(布局探测随之受限)。
const UNSAFE_KEY_PATTERNS: readonly RegExp[] = [
  /^filter\..+\.(clean|smudge|process)$/i,
  /^diff\..+\.(textconv|command)$/i,
  /^diff\.external$/i,
  /^merge\..+\.driver$/i,
  /^gpg\.program$/i,
  /^gpg\..+\.program$/i,
  /^gpg\.ssh\.defaultkeycommand$/i,
  /^core\.(askpass|gitproxy|alternaterefscommand)$/i,
  /^uploadpack\.packobjectshook$/i,
  /^remote\..+\.(uploadpack|receivepack)$/i,
  /^protocol\..+\.allow$/i,
  /^trailer\..+\.(command|cmd)$/i,
  /^lfs\.extension\..+\.(clean|smudge)$/i,
  /^lfs\.customtransfer\..+\.path$/i,
  /^gc\.recentobjectshook$/i,
];

// core.fsmonitor=true/false 是内置 daemon 开关(Scalar 等会在 local 设置),只有非布尔值
// (= 外部 hook 程序路径)才可执行;且已被 `-c core.fsmonitor=false` 覆盖,这里是双保险。
const GIT_BOOLEAN = /^(true|false|yes|no|on|off|1|0|)$/i;
// core.bare=false 是 git init 的默认写法;其它任何值(含无值 = true)都视为"声明没有工作树"。
const GIT_FALSE = /^(false|no|off|0|)$/i;

// diff.submodule=diff 让 diff / show / log -p 在子仓库目录里起 `git diff`,执行**子仓库** config 里的
// diff.external / filter(实测零点击)。exec.ts 已用 `-c diff.submodule=short` + `--submodule=short` 中和,
// 这里是双保险:只有 short / log(都不起子进程)放行,其余值(含无值、未知值)受限。
const SAFE_DIFF_SUBMODULE = /^(short|log)$/i;

const UNTRUSTED_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree']);

export interface ConfigEntry {
  readonly scope: string;
  readonly key: string;
  readonly value: string | null;
}

/** 解析 `git config --list --show-scope -z` 输出:每条 `scope\0key\nvalue\0`(无值键为 `scope\0key\0`)。 */
export function parseScopedConfigList(stdout: string): ConfigEntry[] {
  const parts = stdout.split('\0');
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]!;
    const record = parts[i + 1]!;
    const nl = record.indexOf('\n');
    entries.push(
      nl === -1
        ? { scope, key: record, value: null }
        : { scope, key: record.slice(0, nl), value: record.slice(nl + 1) },
    );
  }
  return entries;
}

/** 重定向类键:让 git 把工作树解析到别处(core.worktree)或声明没有工作树(core.bare)。 */
export function isRedirectConfigEntry(entry: ConfigEntry): boolean {
  if (!UNTRUSTED_SCOPES.has(entry.scope)) return false;
  if (/^core\.worktree$/i.test(entry.key)) return true;
  if (/^core\.bare$/i.test(entry.key)) {
    return entry.value === null || !GIT_FALSE.test(entry.value.trim());
  }
  return false;
}

export function isUnsafeConfigEntry(entry: ConfigEntry): boolean {
  if (!UNTRUSTED_SCOPES.has(entry.scope)) return false;
  if (isRedirectConfigEntry(entry)) return true;
  if (/^core\.fsmonitor$/i.test(entry.key)) {
    return !GIT_BOOLEAN.test((entry.value ?? '').trim());
  }
  if (/^diff\.submodule$/i.test(entry.key)) {
    return !SAFE_DIFF_SUBMODULE.test((entry.value ?? '').trim());
  }
  return UNSAFE_KEY_PATTERNS.some((re) => re.test(entry.key));
}

export type RepoSafety =
  | { readonly kind: 'trusted' }
  | {
      readonly kind: 'restricted';
      readonly reason: 'unsafe-config' | 'unsafe-layout' | 'probe-failed';
      readonly keys: readonly string[];
      readonly message: string;
    };

const DISABLED = 'Git commands are disabled for this repository: ';
const NO_GIT_HERE = 'For safety the viewer does not run git here.';

function unsafeConfigMessage(keys: readonly string[], redirectOnly: boolean): string {
  const shown = keys.slice(0, 5).join(', ');
  const more = keys.length > 5 ? ` and ${keys.length - 5} more` : '';
  const what = redirectOnly
    ? 'settings that point git away from this folder'
    : 'settings that run external programs';
  return (
    `${DISABLED}its local git config defines ${what} (${shown}${more}). ${NO_GIT_HERE} ` +
    `If you trust this folder, review .git/config ` +
    `(including files it includes), remove those settings, then click Refresh.`
  );
}

function layoutRestriction(detail: string): RepoSafety {
  return {
    kind: 'restricted',
    reason: 'unsafe-layout',
    keys: [],
    message: `${DISABLED}${detail} ${NO_GIT_HERE}`,
  };
}

function probeFailure(what: string, r: { stderr?: string; stdout?: string; exitCode?: number | null } | undefined): RepoSafety {
  return {
    kind: 'restricted',
    reason: 'probe-failed',
    keys: [],
    message:
      `${DISABLED}the ${what} safety check failed ` +
      `(${(r?.stderr || r?.stdout || `exit ${r?.exitCode ?? 'unknown'}`).trim()}). ` +
      `git 2.31 or newer is required.`,
  };
}

export const PROBE_ARGS: readonly string[] = [
  'config',
  '--list',
  '--show-scope',
  '--includes',
  '-z',
];

/**
 * 布局探测:一次调用按固定顺序输出 5 行。`--show-toplevel` 放最后——没有工作树时它会 fatal,
 * 前 4 行已经输出(第一行为 false)。
 */
export const LAYOUT_PROBE_ARGS: readonly string[] = [
  'rev-parse',
  '--path-format=absolute',
  '--is-inside-work-tree',
  '--show-prefix',
  '--absolute-git-dir',
  '--git-common-dir',
  '--show-toplevel',
];

const NOT_A_REPO = /^fatal: not a git repository/;

const WORKTREE_ELSEWHERE =
  'git does not use this folder as the top of the repository\'s working tree ' +
  '(the folder is inside a larger repository, the repository is bare, or its configuration ' +
  'points the working tree somewhere else). Open the repository\'s top-level folder instead.';

function isInside(dir: string, parent: string): boolean {
  return dir.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

interface Layout {
  readonly gitDir: string;
  readonly commonDir: string;
}

/** 返回 null = cwd 不在任何仓库里(不受限);RepoSafety = 受限;Layout = 通过,供符号链接检查使用。 */
async function probeLayout(
  app: Pick<CoPluginApp, 'shell'>,
  cwd: string,
): Promise<Layout | RepoSafety | null> {
  // LC_ALL=C:下面要识别 git 的英文报错
  const r = await gitExecUnguarded(app, cwd, LAYOUT_PROBE_ARGS, {
    timeoutMs: 5_000,
    env: { LC_ALL: 'C' },
  });
  if (!r || r.truncated || r.timedOut) return probeFailure('repository layout', r);
  const lines = r.stdout.split('\n');
  if (r.exitCode !== 0) {
    if (r.stdout === '' && NOT_A_REPO.test(r.stderr)) return null;
    if (lines[0] === 'false') return layoutRestriction(WORKTREE_ELSEWHERE);
    return probeFailure('repository layout', r);
  }
  // 恰好 5 行 + 结尾空串;路径里带换行或 git 不认 --path-format(原样回显成一行)都会让段数不对
  if (lines.length !== 6 || lines[5] !== '') return probeFailure('repository layout', r);
  const [inside, prefix, gitDir, commonDir, toplevel] = lines as [string, string, string, string, string];
  if (inside !== 'true' || prefix !== '' || toplevel === '') {
    return layoutRestriction(WORKTREE_ELSEWHERE);
  }
  for (const dir of [gitDir, commonDir]) {
    if (!isInside(dir, toplevel)) {
      return layoutRestriction(
        `its git directory is outside this folder (${dir}). This is the case for a linked ` +
          `worktree or submodule whose main repository lives elsewhere, and for a .git that ` +
          `points at a different repository; the viewer cannot tell these apart, and git would ` +
          `read and write that other location.`,
      );
    }
  }
  return { gitDir, commonDir };
}

type GitDirFs = Pick<CoPluginApp['fs'], 'listDir' | 'lstat'>;

/** 顶层 `hooks` 允许是符号链接(由 repo-hooks 处理);其余被 git 核心读写的位置不允许。 */
function descendInto(rel: string): boolean {
  const first = rel.split('/')[0]!;
  if (first === 'objects') {
    return rel === 'objects' || rel === 'objects/pack' || rel === 'objects/info' || rel.startsWith('objects/info/');
  }
  return first === 'refs' || first === 'logs' || first === 'info' || first === 'reftable';
}

const MAX_SCANNED_DIRS = 5_000;

/** 返回第一个符号链接的相对路径;没有则 null。读取失败抛出(调用方 fail-closed)。 */
async function findSymlink(fs: GitDirFs, gitDir: string): Promise<string | null> {
  let level: string[] = [''];
  let scanned = 0;
  while (level.length > 0) {
    scanned += level.length;
    if (scanned > MAX_SCANNED_DIRS) throw new Error('too many directories under the git directory');
    const listings = await Promise.all(
      level.map(async (rel) => ({ rel, entries: await fs.listDir(rel === '' ? gitDir : `${gitDir}/${rel}`) })),
    );
    const next: string[] = [];
    for (const { rel, entries } of listings) {
      for (const e of entries) {
        const child = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isSymlink) {
          if (child !== 'hooks') return child;
        } else if (e.isDirectory && descendInto(child)) {
          next.push(child);
        }
      }
    }
    level = next;
  }
  return null;
}

async function probeGitDirLinks(
  app: Partial<Pick<CoPluginApp, 'fs'>>,
  layout: Layout,
): Promise<RepoSafety> {
  const fs = app.fs;
  const cannotInspect = (why: string) =>
    layoutRestriction(
      `its git directory could not be inspected for links leading outside this folder (${why}). ` +
        `Grant the plugin file access to the workspace, then click Refresh.`,
    );
  if (!fs || typeof fs.listDir !== 'function' || typeof fs.lstat !== 'function') {
    return cannotInspect('file access is unavailable');
  }
  try {
    for (const dir of new Set([layout.gitDir, layout.commonDir])) {
      const link = await findSymlink(fs, dir);
      if (link !== null) {
        return layoutRestriction(
          `its git directory contains a symbolic link (${link}). Git would read and write ` +
            `through it, possibly outside this folder.`,
        );
      }
    }
    try {
      const alternates = await fs.lstat(`${layout.commonDir}/objects/info/alternates`);
      if (alternates.size > 0 || !alternates.isFile) {
        return layoutRestriction(
          `it borrows objects from another location (objects/info/alternates), ` +
            `possibly outside this folder.`,
        );
      }
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  } catch (err) {
    return cannotInspect(err instanceof Error ? err.message : String(err));
  }
  return { kind: 'trusted' };
}

/** 只读探测(不经守卫):配置 → 布局 → git 目录内的符号链接。任一步失败 fail-closed 为受限。 */
export async function probeRepoSafety(
  app: Pick<CoPluginApp, 'shell'> & Partial<Pick<CoPluginApp, 'fs'>>,
  cwd: string,
): Promise<RepoSafety & { readonly cacheable: boolean }> {
  const r = await gitExecUnguarded(app, cwd, PROBE_ARGS, { timeoutMs: 5_000 });
  if (!r || r.exitCode !== 0 || r.truncated || r.timedOut) {
    return { ...probeFailure('git config', r), cacheable: false };
  }
  const entries = parseScopedConfigList(r.stdout);
  const unsafe = entries.filter(isUnsafeConfigEntry);
  const keys = [...new Set(unsafe.map((e) => e.key))];
  // include / includeIf(条件可能随分支变化)或 worktree 作用域的文件不在 .git/config 的 mtime 里,
  // 有这些时不缓存,每次重新探测。
  const cacheable = !entries.some(
    (e) =>
      UNTRUSTED_SCOPES.has(e.scope) &&
      (e.scope === 'worktree' || /^include(if\..+)?\.path$/i.test(e.key)),
  );
  if (keys.length > 0) {
    return {
      kind: 'restricted',
      reason: 'unsafe-config',
      keys,
      message: unsafeConfigMessage(keys, unsafe.every(isRedirectConfigEntry)),
      cacheable,
    };
  }
  const layout = await probeLayout(app, cwd);
  if (layout === null) return { kind: 'trusted', cacheable: false };
  if ('kind' in layout) return { ...layout, cacheable: false };
  const links = await probeGitDirLinks(app, layout);
  // 布局 / 符号链接的结论不在 .git/config 的 mtime 里:只缓存放行,受限结论每次重新探测。
  return { ...links, cacheable: cacheable && links.kind === 'trusted' };
}

interface CacheEntry {
  readonly signature: string;
  readonly safety: RepoSafety;
}

/**
 * 按仓库根缓存探测结果,失效键为 `<cwd>/.git/config` 的 mtime+size(经 app.fs.stat,不起进程)。
 * stat 不可用(无 fs 授权、.git 是 gitdir 文件、非仓库根)或配置含 include 时不缓存,每次探测。
 * 布局 / 符号链接导致的受限结论不缓存(它们不反映在 config 的 mtime 里);放行结论缓存期间不重查
 * 布局——探测之后才被改动的仓库不在"打开来历不明目录"的威胁模型内,且面板每次 refresh 都强制重探。
 */
export class RepoSafetyGuard {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<RepoSafety>>();

  constructor(private readonly app: Pick<CoPluginApp, 'shell'> & Partial<Pick<CoPluginApp, 'fs'>>) {}

  private async signature(cwd: string): Promise<string | null> {
    const fs = this.app.fs;
    if (!fs || typeof fs.stat !== 'function') return null;
    try {
      const base = cwd.replace(/\/+$/, '');
      const gitDir = await fs.stat(`${base}/.git`);
      if (!gitDir.isDirectory) return null;
      const config = await fs.stat(`${base}/.git/config`);
      return `${config.mtimeMs}:${config.size}`;
    } catch {
      return null;
    }
  }

  async check(cwd: string, opts: { fresh?: boolean } = {}): Promise<RepoSafety> {
    if (!opts.fresh) {
      const pending = this.inflight.get(cwd);
      if (pending) return pending;
    }
    const run = this.run(cwd, opts.fresh === true);
    this.inflight.set(cwd, run);
    try {
      return await run;
    } finally {
      if (this.inflight.get(cwd) === run) this.inflight.delete(cwd);
    }
  }

  private async run(cwd: string, fresh: boolean): Promise<RepoSafety> {
    const before = await this.signature(cwd);
    if (!fresh && before !== null) {
      const hit = this.cache.get(cwd);
      if (hit && hit.signature === before) return hit.safety;
    }
    const { cacheable, ...safety } = await probeRepoSafety(this.app, cwd);
    const after = await this.signature(cwd);
    // 探测期间 config 变了(after≠before)则不缓存,下一次重新探测。
    if (cacheable && before !== null && before === after) {
      this.cache.set(cwd, { signature: before, safety });
    } else {
      this.cache.delete(cwd);
    }
    return safety;
  }
}

/** 给 app.shell 挂上守卫:此后所有经 gitExec 的调用先过受限检测。 */
export function installRepoSafetyGuard(
  app: Pick<CoPluginApp, 'shell'> & Partial<Pick<CoPluginApp, 'fs'>>,
): { readonly guard: RepoSafetyGuard; dispose(): void } {
  const guard = new RepoSafetyGuard(app);
  const registration = registerGitGuard(app.shell, async (cwd) => {
    const safety = await guard.check(cwd);
    return safety.kind === 'trusted' ? null : safety.message;
  });
  return { guard, dispose: () => registration.dispose() };
}
