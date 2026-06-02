import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';

export interface FileOpResult {
  readonly ok: boolean;
  readonly error?: string;
}

export async function stageFile(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
): Promise<FileOpResult> {
  const result = await gitExec(app, repoRoot, ['add', '--', path], {
    timeoutMs: 10_000,
  });

  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: result.stderr || `git add exit ${result.exitCode ?? 'unknown'}`,
  };
}
