import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { isSafeRepoRelativePath, UNSAFE_PATH_ERROR } from './path-utils';
import type { FileOpResult } from './stage-file';

let restoreSupported: boolean | null = null;

const USAGE_EXIT_CODE = 129;
const UNKNOWN_COMMAND_EXIT_CODE = 1;

async function supportsRestore(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<boolean> {
  if (restoreSupported !== null) return restoreSupported;

  const result = await gitExec(app, repoRoot, ['restore', '-h'], {
    timeoutMs: 5_000,
  });
  // `git <cmd> -h` 打印用法:git 2.5x 之前以 129 退出(实测 2.50.1),较新的版本以 0 退出(实测 2.56.1);
  // 命令不存在是 1(`'restore' is not a git command`;按退出码判断,消息会随语言环境变化)。
  // 只缓存这两种确定的结果。超时、被信号终止、被仓库守卫拒绝(128)等都没有说明 git 支持什么:此前它们
  // 也被永久记成"不支持"——一次超时之后整个会话都走 reset。这些情况不缓存,本次走 reset 兜底,下次再探测。
  if (result.timedOut) return false;
  if (result.exitCode === 0 || result.exitCode === USAGE_EXIT_CODE) return (restoreSupported = true);
  if (result.exitCode === UNKNOWN_COMMAND_EXIT_CODE) return (restoreSupported = false);
  return false;
}

export function _resetRestoreCache(): void {
  restoreSupported = null;
}

export async function unstageFile(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
): Promise<FileOpResult> {
  if (!isSafeRepoRelativePath(path)) return { ok: false, error: UNSAFE_PATH_ERROR };
  const useRestore = await supportsRestore(app, repoRoot);
  const args = useRestore
    ? ['restore', '--staged', '--', path]
    : ['reset', 'HEAD', '--', path];
  const result = await gitExec(app, repoRoot, args, {
    timeoutMs: 10_000,
  });

  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: result.stderr || `unstage exit ${result.exitCode ?? 'unknown'}`,
  };
}
