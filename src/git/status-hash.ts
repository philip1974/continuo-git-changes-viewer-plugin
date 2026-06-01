import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';

export async function readStatusHash(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<string> {
  const result = await gitExec(
    app,
    repoRoot,
    ['status', '--porcelain=v1', '-z'],
    { timeoutMs: 5000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git status failed: ${result.stderr}`);
  }
  return result.stdout;
}
