import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
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
//   common dir 不在 `<root>/.git`,故用 rev-parse 定位)。列出其中非 `.sample` 的非目录项。
// - 任一步失败(git 失败、无 app.fs、目录读不到)→ unknown,同样要求确认(fail-closed)。

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
  const dir = commonDir?.exitCode === 0 ? commonDir.stdout.trim() : '';
  if (dir === '') return { kind: 'unknown', reason: 'could not locate the git directory' };

  const fs = app.fs;
  if (!fs || typeof fs.listDir !== 'function' || typeof fs.stat !== 'function') {
    return { kind: 'unknown', reason: 'file access is unavailable' };
  }
  const base = isAbsolutePath(dir) ? dir : `${repoRoot.replace(/[\\/]+$/, '')}/${dir}`;
  const hooksDir = `${base.replace(/[\\/]+$/, '')}/hooks`;
  try {
    const entries = await fs.listDir(hooksDir);
    const hooks = entries
      .filter((e) => !e.isDirectory && !e.name.endsWith('.sample'))
      .map((e) => e.name)
      .sort();
    return hooks.length > 0 ? { kind: 'present', hooks, hooksPath: null } : { kind: 'none' };
  } catch {
    // hooks 目录不存在(git 不会跑任何 hook)与读不到(无授权)要区分:git 目录本身可读才判为无。
    try {
      const st = await fs.stat(base);
      if (st.isDirectory) {
        try {
          await fs.stat(hooksDir);
        } catch {
          return { kind: 'none' };
        }
      }
    } catch {
      // fallthrough
    }
    return { kind: 'unknown', reason: 'could not read the hooks directory' };
  }
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
