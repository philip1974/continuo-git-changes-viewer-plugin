import type {
  CoPluginApp,
  PluginShellExecOptions,
  PluginShellExecResult,
} from '../sdk/types';

export interface GitExecOptions
  extends Pick<
    PluginShellExecOptions,
    'timeoutMs' | 'maxOutputBytes' | 'env' | 'input'
  > {}

// 安全加固(恶意仓库 .git/config 的可执行配置):以下全局选项 / 命令行作用域配置在
// 每次 git 调用前置。命令行 `-c` 优先级高于仓库 local config,故仓库无法覆盖。
// - core.fsmonitor=false:否则 status/diff 刷新索引时执行 core.fsmonitor 指定的程序。
// - log.showSignature=false:否则 log/show 遇到签名提交执行 gpg.program。
// - submodule.recurse=false:不递归进子模块(子模块有自己的 config,本插件不检测)。
// - protocol.allow=never:本插件从不联网;阻断 partial clone 惰性拉取等隐式传输
//   (传输层会执行 core.sshCommand / remote.*.uploadpack / ext:: 等)。
//   例外:会运行用户 hooks 的子命令(commit)不加——`-c` 经 GIT_CONFIG_PARAMETERS 传给 hooks,
//   会让用户 pre-commit 里正常的 clone/fetch 失败。受限仓库(见 repo-safety)根本不会运行 commit。
// - core.hooksPath=/dev/null(同上,commit 例外):禁用仓库 hooks。不止 commit 会跑 hooks——
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
// 注意:不能用 `-c diff.external=` 置空——实测会让 git diff 报错;改为按子命令追加
// `--no-ext-diff`(见 SUBCOMMAND_HARDENING)。
export const GIT_GLOBAL_ARGS: readonly string[] = [
  '--no-optional-locks',
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'submodule.recurse=false',
];

const NO_NETWORK_ARGS: readonly string[] = ['-c', 'protocol.allow=never'];

/** 指向一个不可能是目录的路径,使 git 找不到任何 hook(见上方说明)。 */
export const DISABLED_HOOKS_PATH = '/dev/null';
const NO_HOOKS_ARGS: readonly string[] = ['-c', `core.hooksPath=${DISABLED_HOOKS_PATH}`];

/** 会运行仓库 hooks 的子命令:不禁用 hooks、不注入断网配置,hooks 照常工作(提交前另行确认)。 */
export const HOOK_RUNNING_SUBCOMMANDS: ReadonlySet<string> = new Set(['commit']);

// 子命令级加固,紧跟在子命令名之后插入:
// - diff/show/log:`--no-ext-diff --no-textconv` 不跑 diff.external / diff.<drv>.command /
//   diff.<drv>.textconv;log/show 再加 `--no-show-signature`(与 -c log.showSignature=false 双保险)。
// - status/diff:`--ignore-submodules=dirty`,否则 git 会在嵌套仓库 / 子模块里再起
//   `git status`,而嵌套仓库的 config 不在本插件检测范围内(实测会触发其 filter)。
export const SUBCOMMAND_HARDENING: Readonly<Record<string, readonly string[]>> = {
  status: ['--ignore-submodules=dirty'],
  diff: ['--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty'],
  show: ['--no-ext-diff', '--no-textconv', '--no-show-signature'],
  log: ['--no-ext-diff', '--no-textconv', '--no-show-signature'],
};

// GIT_TERMINAL_PROMPT=0:不在终端提示凭据;GIT_EDITOR=':':git 把 ':' 视为"不启动编辑器",
// 避免执行 core.editor;GIT_NO_LAZY_FETCH=1(git ≥2.45,同上 commit 例外):禁止惰性拉取。
export const GIT_HARDENING_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: ':',
};

const NO_NETWORK_ENV: Readonly<Record<string, string>> = { GIT_NO_LAZY_FETCH: '1' };

function runsHooks(args: readonly string[]): boolean {
  return args[0] !== undefined && HOOK_RUNNING_SUBCOMMANDS.has(args[0]);
}

export function buildGitArgs(args: readonly string[]): string[] {
  const [subcommand, ...rest] = args;
  const globals = runsHooks(args)
    ? GIT_GLOBAL_ARGS
    : [...GIT_GLOBAL_ARGS, ...NO_NETWORK_ARGS, ...NO_HOOKS_ARGS];
  if (subcommand === undefined) return [...globals];
  const extra = SUBCOMMAND_HARDENING[subcommand] ?? [];
  return [...globals, subcommand, ...extra, ...rest];
}

export function buildGitEnv(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return runsHooks(args)
    ? { ...env, ...GIT_HARDENING_ENV }
    : { ...env, ...GIT_HARDENING_ENV, ...NO_NETWORK_ENV };
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
  return app.shell.exec('git', buildGitArgs(args), {
    cwd,
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: opts.maxOutputBytes,
    input: opts.input,
    env: buildGitEnv(args, opts.env),
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
