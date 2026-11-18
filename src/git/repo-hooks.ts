import type { CoPluginApp } from '../sdk/types';
import { gitExec, stripTrailingNewline } from './exec';
import { parseScopedConfigList, PROBE_ARGS } from './repo-safety';

// 提交前的 hooks 检测(安全):commit 是唯一不禁用 hooks 的子命令(见 exec.ts),用户自己仓库的
// pre-commit 等应照常运行;但打开的若是来历不明的目录,commit 会执行攻击者放置的 hooks。
// 因此提交前检测"git 将从哪里找 hook、那里有没有 hook",有则要求用户再确认一次。
//
// - core.hooksPath:取非 command 作用域的最后一个值(command 作用域是插件自己注入的 /dev/null)。
//   来自 local / worktree(仓库可控)→ 视为有 hooks(不去列目录:相对路径语义复杂,且 husky 等
//   常见设置本来就意味着有 hooks)。来自 global / system → 用户自己的 hooks 目录,可信,且 git
//   此时不读 .git/hooks,判为无。
// - 未设置 hooksPath:hooks 在 `<git-common-dir>/hooks`(linked worktree / .git 为 gitdir 文件时
//   common dir 不在 `<root>/.git`,故用 rev-parse 定位)。先 lstat(不跟随链接)hooks 路径:
//   · 只有明确的 ENOENT 才判为无(git 不会跑任何 hook)。
//   · 普通目录或符号链接 → listDir 列出非 `.sample` 的非目录项。符号链接由宿主 listDir 先 realpath
//     再判 scope:指向 workspace 外(如压缩包里的 `repo/.git/hooks -> ../../evilhooks`,git 会跟随
//     执行)时抛 scope 错误 → unknown;不能把"读不到"当成"不存在"。
//   · 其它类型(普通文件等)→ unknown。
// - 任一步失败(git 失败、无 app.fs / lstat、scope 错误、EACCES 等)→ unknown,同样要求确认(fail-closed)。

export type RepoHooks =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'present';
      /** 检测到的 hook 文件名(hooksPath 情形为空)。 */
      readonly hooks: readonly string[];
      /** 仓库 local / worktree 设置的 core.hooksPath;未设置为 null。 */
      readonly hooksPath: string | null;
    }
  | { readonly kind: 'unknown'; readonly reason: string };

const LOCAL_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree']);

function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:)?[\\/]/.test(p);
}

export async function detectRepoHooks(
  app: Pick<CoPluginApp, 'shell'> & Partial<Pick<CoPluginApp, 'fs'>>,
  repoRoot: string,
): Promise<RepoHooks> {
  const config = await gitExec(app, repoRoot, PROBE_ARGS, { timeoutMs: 5_000 });
  if (!config || config.exitCode !== 0 || config.truncated || config.timedOut) {
    return { kind: 'unknown', reason: 'could not read git config' };
  }
  const hooksPathEntries = parseScopedConfigList(config.stdout).filter(
    (e) => e.scope !== 'command' && e.key.toLowerCase() === 'core.hookspath',
  );
  const effective = hooksPathEntries[hooksPathEntries.length - 1];
  if (effective) {
    if (LOCAL_SCOPES.has(effective.scope)) {
      return { kind: 'present', hooks: [], hooksPath: effective.value ?? '' };
    }
    return { kind: 'none' };
  }

  const commonDir = await gitExec(app, repoRoot, ['rev-parse', '--git-common-dir'], {
    timeoutMs: 5_000,
  });
  // 只去掉 git 输出的一个结尾换行,不能 trim:目录名可以带首尾空白(压缩包里 `.git` 为文件
  // `gitdir: gd `、真实 git 目录为 `gd /`,git 读 gitfile 只去换行),trim 后会 lstat 一个不存在的
  // `gd/hooks` 而误判为无 hooks。
  const dir = commonDir?.exitCode === 0 ? stripTrailingNewline(commonDir.stdout) : '';
  if (dir === '') return { kind: 'unknown', reason: 'could not locate the git directory' };

  const fs = app.fs;
  if (!fs || typeof fs.listDir !== 'function' || typeof fs.lstat !== 'function') {
    return { kind: 'unknown', reason: 'file access is unavailable' };
  }
  const base = isAbsolutePath(dir) ? dir : `${repoRoot.replace(/[\\/]+$/, '')}/${dir}`;
  const hooksDir = `${base.replace(/[\\/]+$/, '')}/hooks`;
  let st: { readonly isDirectory: boolean; readonly isSymlink: boolean };
  try {
    st = await fs.lstat(hooksDir);
  } catch (err) {
    if (isNotFoundError(err)) return { kind: 'none' };
    return { kind: 'unknown', reason: 'could not read the hooks directory' };
  }
  if (!st.isDirectory && !st.isSymlink) {
    return { kind: 'unknown', reason: 'the hooks path is not a directory' };
  }
  try {
    const entries = await fs.listDir(hooksDir);
    const hooks = entries
      .filter((e) => !e.isDirectory && !e.name.endsWith('.sample'))
      .map((e) => e.name)
      .sort();
    return hooks.length > 0 ? { kind: 'present', hooks, hooksPath: null } : { kind: 'none' };
  } catch {
    return {
      kind: 'unknown',
      reason: st.isSymlink
        ? 'the hooks directory is a symbolic link that could not be read'
        : 'could not read the hooks directory',
    };
  }
}

// 宿主 plugin-fs 错误经 ipcRenderer.invoke 传回时只剩 message(code 丢失),形如
// "Error invoking remote method 'plugin-fs:lstat': Error: ENOENT: no such file or directory, lstat '<path>'"。
// 只认 message 开头(可选 IPC 前缀之后紧跟)的 `ENOENT:`——路径(可被仓库所在目录名控制)总在末尾,
// 不能用"包含 ENOENT"判断,否则 `/x: ENOENT: …/repo` 这类目录名下的 scope 错误会被误判为不存在。
const NOT_FOUND_MESSAGE = /^(?:Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?)?ENOENT: /;

function isNotFoundError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') {
    return true;
  }
  return err instanceof Error && NOT_FOUND_MESSAGE.test(err.message);
}

export function describeRepoHooks(hooks: Exclude<RepoHooks, { kind: 'none' }>): string {
  if (hooks.kind === 'unknown') {
    return (
      `Could not check this repository for git hooks (${hooks.reason}). ` +
      `Any hooks it contains will run when you commit.`
    );
  }
  if (hooks.hooksPath !== null) {
    return (
      `This repository sets core.hooksPath (${hooks.hooksPath || 'empty'}). ` +
      `Git hooks there will run when you commit.`
    );
  }
  const shown = hooks.hooks.slice(0, 5).join(', ');
  const more = hooks.hooks.length > 5 ? ` and ${hooks.hooks.length - 5} more` : '';
  return `This repository contains git hooks (${shown}${more}). They will run when you commit.`;
}
