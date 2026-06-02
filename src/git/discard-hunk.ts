import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';

export interface DiscardHunkResult {
  readonly ok: boolean;
  readonly error?: string;
}

export async function discardHunk(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  patch: string,
): Promise<DiscardHunkResult> {
  const result = await gitExec(
    app,
    repoRoot,
    ['apply', '--reverse', '--whitespace=nowarn', '-'],
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
