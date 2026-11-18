import type { CoPluginApp } from '../sdk/types';
import { gitExecUnguarded, registerGitGuard } from './exec';

// 受限仓库检测(安全):打开一个含攻击者控制 .git/config 的目录(解压包 / 共享盘)时,
// git 会按仓库 local config 执行外部程序——filter.<drv>.clean 在 `git status` 重新哈希时就会运行,
// 且 git 没有全局关闭 filter 的开关。因此在运行任何 git 命令前,先只读探测仓库作用域
// (local / worktree,含 include / includeIf 引入的文件)的配置;命中可执行类键即进入受限状态,
// 不再运行任何 git 命令(fail-closed)。
//
// 探测命令 `git config --list --show-scope --includes -z` 只读配置文件,不执行任何程序
// (实测:恶意 filter/textconv/diff.external/fsmonitor/gpg.program 均不触发)。
// 全局 / 系统 config 是用户自己的,可信,不检测。
//
// 未列入的可执行键及原因(已用其它方式中和):
// - core.pager / pager.*:全局 `--no-pager`。
// - core.editor / sequence.editor:env GIT_EDITOR=':'。
// - diff.external:另加 `--no-ext-diff`(本列表仍检测,双保险)。
// - core.sshCommand / credential.* / core.askPass 以外的传输类:只在联网时执行,而读命令已
//   `-c protocol.allow=never` + GIT_NO_LAZY_FETCH=1 断网;per-repo sshCommand / credential.helper
//   是常见的合法配置,检测会误伤。
// - core.hooksPath / .git/hooks:hooks 只在用户主动 commit / discard 时运行,与在终端执行
//   `git commit` 同一信任模型;husky 等工具普遍设置 local core.hooksPath,检测会误伤。
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
];

// core.fsmonitor=true/false 是内置 daemon 开关(Scalar 等会在 local 设置),只有非布尔值
// (= 外部 hook 程序路径)才可执行;且已被 `-c core.fsmonitor=false` 覆盖,这里是双保险。
const GIT_BOOLEAN = /^(true|false|yes|no|on|off|1|0|)$/i;

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

export function isUnsafeConfigEntry(entry: ConfigEntry): boolean {
  if (!UNTRUSTED_SCOPES.has(entry.scope)) return false;
  if (/^core\.fsmonitor$/i.test(entry.key)) {
    return !GIT_BOOLEAN.test((entry.value ?? '').trim());
  }
  return UNSAFE_KEY_PATTERNS.some((re) => re.test(entry.key));
}

export type RepoSafety =
  | { readonly kind: 'trusted' }
  | {
      readonly kind: 'restricted';
      readonly reason: 'unsafe-config' | 'probe-failed';
      readonly keys: readonly string[];
      readonly message: string;
    };

function unsafeConfigMessage(keys: readonly string[]): string {
  const shown = keys.slice(0, 5).join(', ');
  const more = keys.length > 5 ? ` and ${keys.length - 5} more` : '';
  return (
    `Git commands are disabled for this repository: its local git config defines ` +
    `settings that run external programs (${shown}${more}). For safety the viewer ` +
    `does not run git here. If you trust this folder, review .git/config ` +
    `(including files it includes), remove those settings, then click Refresh.`
  );
}

export const PROBE_ARGS: readonly string[] = [
  'config',
  '--list',
  '--show-scope',
  '--includes',
  '-z',
];

/** 只读探测仓库作用域配置(不经守卫)。探测失败 fail-closed 为受限。 */
export async function probeRepoSafety(
  app: Pick<CoPluginApp, 'shell'>,
  cwd: string,
): Promise<RepoSafety & { readonly cacheable: boolean }> {
  const r = await gitExecUnguarded(app, cwd, PROBE_ARGS, { timeoutMs: 5_000 });
  if (!r || r.exitCode !== 0 || r.truncated || r.timedOut) {
    return {
      kind: 'restricted',
      reason: 'probe-failed',
      keys: [],
      message:
        `Git commands are disabled for this repository: the git config safety check failed ` +
        `(${(r?.stderr || r?.stdout || `exit ${r?.exitCode ?? 'unknown'}`).trim()}). ` +
        `git 2.26 or newer is required.`,
      cacheable: false,
    };
  }
  const entries = parseScopedConfigList(r.stdout);
  const keys = [...new Set(entries.filter(isUnsafeConfigEntry).map((e) => e.key))];
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
      message: unsafeConfigMessage(keys),
      cacheable,
    };
  }
  return { kind: 'trusted', cacheable };
}

interface CacheEntry {
  readonly signature: string;
  readonly safety: RepoSafety;
}

/**
 * 按仓库根缓存探测结果,失效键为 `<cwd>/.git/config` 的 mtime+size(经 app.fs.stat,不起进程)。
 * stat 不可用(无 fs 授权、.git 是 gitdir 文件、非仓库根)或配置含 include 时不缓存,每次探测。
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
