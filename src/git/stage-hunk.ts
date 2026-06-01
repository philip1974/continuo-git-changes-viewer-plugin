import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';

export interface StageHunkResult {
  readonly ok: boolean;
  readonly error?: string;
}

export async function stageHunk(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  patch: string,
): Promise<StageHunkResult> {
  const result = await gitExec(
    app,
    repoRoot,
    ['apply', '--cached', '--whitespace=nowarn', '-'],
    {
      input: patch,
      timeoutMs: 10_000,
    },
  );

  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: result.stderr || `git apply exit ${result.exitCode ?? 'unknown'}`,
  };
}
