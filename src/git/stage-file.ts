import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { isSafeRepoRelativePath, UNSAFE_PATH_ERROR } from './path-utils';

export interface FileOpResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface StageFileOptions {
  /**
   * 该路径是 status 报告的未跟踪条目(`??`)。它的名字来自 git 读目录(按仓库的 core.precomposeUnicode
   * 转换过),`git add` 也要按同样的设置读目录才能找到它——见 exec.ts 的 LITERAL_ARGV_CONFIG。
   */
  readonly untracked?: boolean;
}

export async function stageFile(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
  opts: StageFileOptions = {},
): Promise<FileOpResult> {
  if (!isSafeRepoRelativePath(path)) return { ok: false, error: UNSAFE_PATH_ERROR };
  const result = await gitExec(app, repoRoot, ['add', '--', path], {
    timeoutMs: 10_000,
    ...(opts.untracked ? { untrackedPathArgs: true } : {}),
  });

  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: result.stderr || `git add exit ${result.exitCode ?? 'unknown'}`,
  };
}
