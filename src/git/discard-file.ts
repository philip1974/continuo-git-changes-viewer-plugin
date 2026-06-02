import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import type { FileOpResult } from './stage-file';

export async function discardFile(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
): Promise<FileOpResult> {
  const result = await gitExec(app, repoRoot, ['checkout', '--', path], {
    timeoutMs: 10_000,
  });

  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: result.stderr || `git checkout -- exit ${result.exitCode ?? 'unknown'}`,
  };
}
