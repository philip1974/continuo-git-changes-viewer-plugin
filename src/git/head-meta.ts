import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';

export async function hasHeadCommit(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<boolean> {
  const result = await gitExec(app, repoRoot, ['rev-parse', '--verify', 'HEAD'], {
    timeoutMs: 5_000,
  });
  if (!result) return false;
  return result.exitCode === 0;
}

export async function readHeadMessage(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<string | null> {
  const result = await gitExec(app, repoRoot, ['log', '-1', '--pretty=%B'], {
    timeoutMs: 5_000,
  });
  if (!result) return null;
  if (result.exitCode !== 0) return null;
  return result.stdout.replace(/\n+$/, '');
}

export async function readHeadSha(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<string | null> {
  const result = await gitExec(app, repoRoot, ['rev-parse', 'HEAD'], {
    timeoutMs: 5_000,
  });
  if (!result) return null;
  if (result.exitCode !== 0) return null;

  const sha = result.stdout.trim();
  return sha === '' ? null : sha;
}
