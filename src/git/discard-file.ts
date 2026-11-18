import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { isSafeRepoRelativePath, UNSAFE_PATH_ERROR } from './path-utils';
import type { FileOpResult } from './stage-file';

export async function discardFile(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
): Promise<FileOpResult> {
  if (!isSafeRepoRelativePath(path)) return { ok: false, error: UNSAFE_PATH_ERROR };
  const result = await gitExec(app, repoRoot, ['checkout', '--', path], {
    timeoutMs: 10_000,
  });

  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: result.stderr || `git checkout -- exit ${result.exitCode ?? 'unknown'}`,
  };
}
