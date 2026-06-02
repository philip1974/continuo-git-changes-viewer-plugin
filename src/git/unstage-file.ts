import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import type { FileOpResult } from './stage-file';

let restoreSupported: boolean | null = null;

async function supportsRestore(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<boolean> {
  if (restoreSupported !== null) return restoreSupported;

  const result = await gitExec(app, repoRoot, ['restore', '-h'], {
    timeoutMs: 5_000,
  });
  restoreSupported = result.exitCode === 0;
  return restoreSupported;
}

export function _resetRestoreCache(): void {
  restoreSupported = null;
}

export async function unstageFile(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
): Promise<FileOpResult> {
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
