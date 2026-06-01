import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';

export interface UnstageHunkResult {
  readonly ok: boolean;
  readonly error?: string;
}

export async function unstageHunk(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  patch: string,
): Promise<UnstageHunkResult> {
  const result = await gitExec(
    app,
    repoRoot,
    ['apply', '--cached', '--reverse', '--whitespace=nowarn', '-'],
    {
      input: patch,
      timeoutMs: 10_000,
    },
  );

  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: result.stderr || `git apply --reverse exit ${result.exitCode ?? 'unknown'}`,
  };
}
