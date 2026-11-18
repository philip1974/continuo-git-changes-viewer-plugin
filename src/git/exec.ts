import type {
  CoPluginApp,
  PluginShellExecOptions,
  PluginShellExecResult,
} from '../sdk/types';

export interface GitExecOptions
  extends Pick<
    PluginShellExecOptions,
    'timeoutMs' | 'maxOutputBytes' | 'env' | 'input'
  > {
  /**
   * 仅对会运行 hooks 的子命令(commit)有意义:用户已在提交前的 hooks 确认框里同意运行仓库 hooks。
   * 只有这时 commit 才不注入断网参数 / 环境变量(见 buildGitArgs)。
   */
  readonly repoHooksConfirmed?: boolean;
}

// 安全加固(恶意仓库 .git/config 的可执行配置):以下全局选项 / 命令行作用域配置在
// 每次 git 调用前置。命令行 `-c` 优先级高于仓库 local config,故仓库无法覆盖。
// - core.fsmonitor=false:否则 status/diff 刷新索引时执行 core.fsmonitor 指定的程序。
// - log.showSignature=false:否则 log/show 遇到签名提交执行 gpg.program。
// - submodule.recurse=false:不递归进子模块(子模块有自己的 config,本插件不检测)。
// - protocol.allow=never:本插件从不联网;阻断 partial clone 惰性拉取等隐式传输
//   (传输层会执行 core.sshCommand / credential.helper / remote.*.uploadpack / ext:: 等)。
//   唯一例外:用户已确认运行仓库 hooks 的 commit(repoHooksConfirmed)——`-c` 经 GIT_CONFIG_PARAMETERS、
//   环境变量经进程 env 传给 hooks,会让用户 pre-commit 里正常的 clone / fetch 失败;此时用户已同意
//   执行仓库代码,断网不再提供额外保护。没有仓库 hooks(不弹确认)的 commit 同样断网:commit 结束时
//   打印变更摘要要读旧 blob,partial clone 配置 + 缺失对象会触发惰性拉取并执行 core.sshCommand /
//   credential.helper(实测 git 2.50),而这条路径没有任何确认。
// - core.hooksPath=/dev/null(commit 例外):禁用仓库 hooks。不止 commit 会跑 hooks——
//   写 index 的 add / apply --cached / restore --staged / reset 触发 post-index-change,
//   checkout / restore 触发 post-checkout,改 ref 的命令触发 reference-transaction;恶意目录只需
//   放一个可执行的 .git/hooks/post-index-change,用户点一次 Stage 就会执行(实测 git 2.50)。
//   依据:git 按 `<hooksPath>/<hook名>` 查找 hook,`/dev/null` 不是目录,其下不可能存在文件,
//   故任何 hook 都找不到(实测 add/apply/restore/reset/checkout 均不再执行 hook)。不能用空值
//   `core.hooksPath=`——会被拼成 `/<hook名>`(文件系统根)。Windows(Git for Windows)上 `/dev/null`
//   解析为当前盘符下的 `\dev\null`,同样不存在;只有能在盘符根目录写文件的本机攻击者才能放置,
//   超出"恶意仓库"威胁模型(未在 Windows 实机验证)。commit 照常运行用户 hooks,提交前由
//   repo-hooks 检测并要求确认。
// - --no-pager:不启动 core.pager / pager.*。
// - diff.submodule=short / status.submoduleSummary=false / maintenance.auto=false / gc.auto=0:见 PINNED_CONFIG。
// 注意:不能用 `-c diff.external=` 置空——实测会让 git diff 报错;改为按子命令追加
// `--no-ext-diff`(见 SUBCOMMAND_HARDENING)。

// 以 `-c key=value` 固定的配置(命令行作用域优先于仓库 config,不依赖受限键黑名单)。
// 原则:任何 git 子命令都不得在嵌套仓库 / 子模块里起子进程——子进程读的是**那个**仓库自己的 config
// (diff.external / filter / textconv ...),不在本插件的受限检测范围内,也不继承 `--no-ext-diff`。
export const PINNED_CONFIG: ReadonlyArray<readonly [key: string, value: string]> = [
  ['core.fsmonitor', 'false'],
  ['log.showSignature', 'false'],
  ['submodule.recurse', 'false'],
  // 外层 `diff.submodule=diff` 会让 diff / show / log -p 对有差异的 gitlink 在子仓库目录里起
  // `git diff --submodule=diff A B`(实测 git 2.50:零点击执行子仓库的 diff.external / filter)。
  // `log` 取值在进程内读子仓库对象库(可借 gitfile 指向别的仓库),一并固定为 short。
  ['diff.submodule', 'short'],
  // 非 porcelain 的 status(commit 在编辑器模板里也会生成)据此运行 `git submodule summary`,
  // 后者在子仓库里起 `git rev-parse / rev-list / log`。
  ['status.submoduleSummary', 'false'],
  // commit 结束后会起 `git maintenance run --auto --detach`(gc / repack 等后台任务,
  // 行为由仓库的 gc.* / maintenance.* / pack.* / repack.* 决定)。插件的提交不触发它;
  // 用户在终端里的 git 操作照常触发。gc.auto=0 兼顾没有 maintenance.auto 的旧版 git。
  ['maintenance.auto', 'false'],
  ['gc.auto', '0'],
  // git 自己的"路径不得解析成 .git"保护(apply / checkout 写工作树时生效)可被仓库 config 关掉;固定为开。
  // 插件另有不依赖它的 isSafeRepoRelativePath(见 path-utils)。
  ['core.protectHFS', 'true'],
  ['core.protectNTFS', 'true'],
  // 插件经 stdin 传入的提交信息一律是 UTF-8;仓库设成别的编码会给提交打上错误的 encoding 头,
  // 之后 log 按它转码就成了乱码。
  ['i18n.commitEncoding', 'UTF-8'],
];

// 只影响"插件要解析的输出"的固定配置:除 commit 外的每次调用都加。commit 不加——它的输出插件不解析,
// 而 `-c` 会经 GIT_CONFIG_PARAMETERS 传给用户 hooks,不该无谓地改变 hooks 里 git 命令的行为。
export const PINNED_OUTPUT_CONFIG: ReadonlyArray<readonly [key: string, value: string]> = [
  // status / diff 的重命名检测固定为 git 默认值。仓库设 `status.renames=copies` 时 porcelain 会输出
  // 复制记录(`C  新\0原\0`),设 false 则重命名显示成一删一增——文件列表不应随仓库 config 变形。
  ['status.renames', 'true'],
  ['diff.renames', 'true'],
  // 颜色:`color.diff=always` / `color.ui=always` 让非终端输出也带 ANSI 转义,hunk 头(`@@`)识别、
  // 行号计算、hunk 补丁提取全部错位(实测)。更具体的 color.diff 优先于 color.ui,两个都要固定;
  // diff / show / log 另加 `--no-color`。
  ['color.ui', 'false'],
  ['color.diff', 'false'],
  // diff 头与 hunk 形状:插件按 `a/<path>` / `b/<path>` 生成 hunk 补丁,并假设 git 默认的 3 行上下文。
  // 仓库可以把前缀改掉(noprefix / mnemonicPrefix / srcPrefix / dstPrefix)、把上下文设成 0
  // (零上下文补丁 `git apply` 可能落到错误位置)、去掉空上下文行的前导空格、按子目录裁剪路径。
  ['diff.noprefix', 'false'],
  ['diff.mnemonicPrefix', 'false'],
  ['diff.srcPrefix', 'a/'],
  ['diff.dstPrefix', 'b/'],
  ['diff.context', '3'],
  ['diff.interHunkContext', '0'],
  ['diff.suppressBlankEmpty', 'false'],
  ['diff.relative', 'false'],
  // `i18n.logOutputEncoding=UTF-16` 之类会让 log 输出(读 HEAD 提交信息供 amend 预填)变成别的编码。
  ['i18n.logOutputEncoding', 'UTF-8'],
  // hunk 补丁必须按原样匹配;`apply.ignoreWhitespace=change` 会让它模糊匹配到别处。
  ['apply.ignoreWhitespace', 'no'],
];

const pins = (config: ReadonlyArray<readonly [string, string]>): string[] =>
  config.flatMap(([key, value]) => ['-c', `${key}=${value}`]);

export const GIT_GLOBAL_ARGS: readonly string[] = ['--no-optional-locks', '--no-pager', ...pins(PINNED_CONFIG)];

const OUTPUT_ARGS: readonly string[] = pins(PINNED_OUTPUT_CONFIG);

const NO_NETWORK_ARGS: readonly string[] = ['-c', 'protocol.allow=never'];

/** 指向一个不可能是目录的路径,使 git 找不到任何 hook(见上方说明)。 */
export const DISABLED_HOOKS_PATH = '/dev/null';

// 配置式 hooks(git >= 2.54):`[hook "x"] event = post-index-change` + `command = <任意命令>` 写在 config 里,
// git 在对应事件执行该命令,**不经 hooks 目录**——core.hooksPath=/dev/null 对它无效(实测 git 2.56.1:
// 仓库 config 里的这种 hook 在 add 以及会刷新 index 的 status 上都执行)。仓库作用域的 `hook.*` 由
// repo-safety 列为受限键(主防线,对 2.54 起的所有版本有效);这里是纵深,同时让"非 commit 子命令
// 不运行任何 hook"对用户自己 global / system config 里的配置式 hooks 同样成立(与全局 core.hooksPath
// 的目录式 hook 被 /dev/null 禁掉一致):git >= 2.55 的事件级开关 `hook.<event>.enabled=false` 关掉该事件的
// 全部 hook(配置式与目录式),命令行作用域最后解析,仓库 config 无法再打开(实测)。git 没有"关掉全部
// 配置式 hooks"的总开关或环境变量(hook.c 无此逻辑),只能逐事件列出;列表取自 git 2.56 githooks(5)。
// git 2.54 没有事件级开关:这些 `-c` 在那里只是给一个不存在的 hook 名设 enabled(无效果,也不报错),
// 全局配置式 hooks 在 2.54 上照常运行(它们是用户自己的)。更早的 git 完全不读 hook.*。
export const KNOWN_HOOK_EVENTS: readonly string[] = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist',
  'p4-pre-submit', 'post-index-change',
];

const NO_HOOKS_ARGS: readonly string[] = [
  '-c',
  `core.hooksPath=${DISABLED_HOOKS_PATH}`,
  ...KNOWN_HOOK_EVENTS.flatMap((event) => ['-c', `hook.${event}.enabled=false`]),
];

/** 会运行仓库 hooks 的子命令:不禁用 hooks(提交前另行确认);仅在用户确认运行仓库 hooks 后才不断网。 */
export const HOOK_RUNNING_SUBCOMMANDS: ReadonlySet<string> = new Set(['commit']);

// 子命令级加固,紧跟在子命令名之后插入:
// - diff/show/log:`--no-ext-diff --no-textconv` 不跑 diff.external / diff.<drv>.command /
//   diff.<drv>.textconv;log/show 再加 `--no-show-signature`(与 -c log.showSignature=false 双保险)。
// - diff/show/log:`--submodule=short`(与 -c diff.submodule=short 双保险,见 PINNED_CONFIG)。
// - status/diff:`--ignore-submodules=dirty`,否则 git 会在嵌套仓库 / 子模块里再起
//   `git status --porcelain=2`,而嵌套仓库的 config 不在本插件检测范围内(实测会触发其 filter)。
//   必须用命令行参数:`-c diff.ignoreSubmodules=dirty` 会被 .gitmodules / 仓库 config 里的
//   `submodule.<name>.ignore=none` 盖过(实测)。不用 `all`:gitlink 指向的提交变化仍应显示,
//   而读子仓库 HEAD 是进程内读文件,不起子进程(GIT_TRACE 实测)。
// - commit:`--quiet`。不加时 commit 结束会打印变更摘要(`N files changed ...`),为此读取旧 blob;
//   partial clone 里旧 blob 缺失即触发惰性拉取(→ core.sshCommand / credential.helper,实测),
//   断网后则以 `fatal: unable to read <oid>` 退出 128——提交其实已创建,却报告失败。加 --quiet 后
//   根本不读旧 blob(实测:不断网也不拉取),"nothing to commit" 等失败信息照常输出;插件不使用该摘要。
// - diff/show/log:`--no-color`(与 -c color.ui / color.diff=false 双保险,见 PINNED_OUTPUT_CONFIG)。
export const SUBCOMMAND_HARDENING: Readonly<Record<string, readonly string[]>> = {
  commit: ['--quiet'],
  status: ['--ignore-submodules=dirty'],
  diff: ['--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--submodule=short', '--no-color'],
  show: ['--no-ext-diff', '--no-textconv', '--no-show-signature', '--submodule=short', '--no-color'],
  log: ['--no-ext-diff', '--no-textconv', '--no-show-signature', '--submodule=short', '--no-color'],
};

// GIT_TERMINAL_PROMPT=0:不在终端提示凭据;GIT_EDITOR=':':git 把 ':' 视为"不启动编辑器",
// 避免执行 core.editor;GIT_NO_LAZY_FETCH=1(git ≥2.45;已确认 hooks 的 commit 例外):禁止惰性拉取。
// GIT_ALLOW_PROTOCOL=''(同样的例外):允许的传输协议为空列表。`-c protocol.allow=never` 不够——
// 仓库 config 里的 `protocol.<name>.allow=always` 优先于它;而该环境变量设置后 git 完全不看
// protocol.*.allow 配置,任何 config 都覆盖不了(实测 git 2.50:partial clone + 仓库设
// protocol.file.allow=always + remote.origin.uploadpack,去掉 GIT_NO_LAZY_FETCH 时仅靠 -c 会拉取并执行
// uploadpack,加上本变量则 `transport 'file' not allowed`)。
export const GIT_HARDENING_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: ':',
};

const NO_NETWORK_ENV: Readonly<Record<string, string>> = {
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
};

// GIT_LITERAL_PATHSPECS=1:路径参数按字面处理。git 默认把 `--` 之后的参数当 pathspec(glob + `:(magic)`):
// 文件名 `*` / `:(glob)**` / `[id].tsx` 会让"暂存 / 丢弃这一个文件"作用到其它文件(`[id].tsx` 还匹配
// `i.tsx`),而确认框只显示一个文件名(实测)。插件传给 git 的路径全部来自 status 的逐字输出,从不需要
// 通配。commit 例外:插件的 commit 不带路径参数,而环境变量会传给 hooks(lint-staged 等在 hooks 里
// 用 glob pathspec)。另外三个全局 pathspec 变量显式置 0:用户环境里若开着任何一个,git 会以
// "literal is incompatible with all other global pathspec settings" 直接失败(实测)。
const LITERAL_PATHSPEC_ENV: Readonly<Record<string, string>> = {
  GIT_LITERAL_PATHSPECS: '1',
  GIT_GLOB_PATHSPECS: '0',
  GIT_NOGLOB_PATHSPECS: '0',
  GIT_ICASE_PATHSPECS: '0',
};

function runsHooks(args: readonly string[]): boolean {
  return args[0] !== undefined && HOOK_RUNNING_SUBCOMMANDS.has(args[0]);
}

export interface GitHardeningOptions {
  readonly repoHooksConfirmed?: boolean;
}

/** 只有"用户已确认运行仓库 hooks 的 commit"保留联网能力(hooks 里可能要 fetch)。 */
function networkAllowed(args: readonly string[], opts: GitHardeningOptions): boolean {
  return runsHooks(args) && opts.repoHooksConfirmed === true;
}

export function buildGitArgs(args: readonly string[], opts: GitHardeningOptions = {}): string[] {
  const [subcommand, ...rest] = args;
  const globals = [
    ...GIT_GLOBAL_ARGS,
    ...(networkAllowed(args, opts) ? [] : NO_NETWORK_ARGS),
    ...(runsHooks(args) ? [] : [...NO_HOOKS_ARGS, ...OUTPUT_ARGS]),
  ];
  if (subcommand === undefined) return globals;
  const extra = SUBCOMMAND_HARDENING[subcommand] ?? [];
  return [...globals, subcommand, ...extra, ...rest];
}

export function buildGitEnv(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  opts: GitHardeningOptions = {},
): Record<string, string> {
  return {
    ...env,
    ...GIT_HARDENING_ENV,
    ...(networkAllowed(args, opts) ? {} : NO_NETWORK_ENV),
    ...(runsHooks(args) ? {} : LITERAL_PATHSPEC_ENV),
  };
}

/**
 * 仓库级守卫:返回 null 表示放行;返回字符串表示拒绝(作为 stderr 返回给调用方)。
 * 通过 registerGitGuard 绑定到具体 app.shell 实例,所有经 gitExec 的调用都会先过守卫。
 */
export type GitGuard = (cwd: string) => Promise<string | null>;

const guards = new WeakMap<object, GitGuard>();

export function registerGitGuard(
  shell: object,
  guard: GitGuard,
): { dispose(): void } {
  guards.set(shell, guard);
  return {
    dispose: () => {
      if (guards.get(shell) === guard) guards.delete(shell);
    },
  };
}

export const GIT_REFUSED_EXIT_CODE = 128;

/** 不经守卫直接执行(仅供守卫自身的只读探测使用)。 */
export async function gitExecUnguarded(
  app: Pick<CoPluginApp, 'shell'>,
  cwd: string,
  args: readonly string[],
  opts: GitExecOptions = {},
): Promise<PluginShellExecResult> {
  const hardening = { repoHooksConfirmed: opts.repoHooksConfirmed };
  return app.shell.exec('git', buildGitArgs(args, hardening), {
    cwd,
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: opts.maxOutputBytes,
    input: opts.input,
    env: buildGitEnv(args, opts.env, hardening),
  });
}

export async function gitExec(
  app: Pick<CoPluginApp, 'shell'>,
  cwd: string,
  args: readonly string[],
  opts: GitExecOptions = {},
): Promise<PluginShellExecResult> {
  const guard = guards.get(app.shell);
  if (guard) {
    let refusal: string | null;
    try {
      refusal = await guard(cwd);
    } catch (err) {
      // fail-closed:守卫自身异常也拒绝执行
      refusal = `Git safety check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (refusal !== null) {
      return {
        stdout: '',
        stderr: refusal,
        exitCode: GIT_REFUSED_EXIT_CODE,
        signal: null,
        timedOut: false,
        truncated: false,
      };
    }
  }
  return gitExecUnguarded(app, cwd, args, opts);
}

/**
 * 去掉 git 输出末尾的一个换行(`\n` 或 `\r\n`),保留其余空白。git 输出的**路径**(rev-parse
 * --git-common-dir / --show-prefix 等)必须用它而不是 trim():目录名可以带首尾空白,trim 会把
 * `.../gd ` 变成另一个路径。
 */
export function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, '');
}
