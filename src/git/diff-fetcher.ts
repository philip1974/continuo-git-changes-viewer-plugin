import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import type { FileChange } from './status-scanner';

export type DiffResult =
  | { ok: true; path: string; diff: string }
  | {
      ok: false;
      reason: 'too-large' | 'git-error';
      path: string;
      exactCommand: string;
      message?: string;
    };

function trackedCommand(path: string): string {
  return `git diff HEAD -- ${path}`;
}

function untrackedCommand(path: string): string {
  return `git diff --no-index --binary --no-color /dev/null ${path}`;
}

export async function fetchDiff(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  change: FileChange,
): Promise<DiffResult> {
  const untracked = change.status === 'U';
  const args = untracked
    ? ['diff', '--no-index', '--binary', '--no-color', '/dev/null', change.path]
    : ['diff', 'HEAD', '--', change.path];
  const exactCommand = untracked
    ? untrackedCommand(change.path)
    : trackedCommand(change.path);

  const r = await gitExec(app, repoRoot, args);
  if (r.truncated) {
    return {
      ok: false,
      reason: 'too-large',
      path: change.path,
      exactCommand,
    };
  }

  const okExit = untracked ? r.exitCode === 0 || r.exitCode === 1 : r.exitCode === 0;
  if (!okExit) {
    return {
      ok: false,
      reason: 'git-error',
      path: change.path,
      exactCommand,
      message: r.stderr || r.stdout,
    };
  }

  return { ok: true, path: change.path, diff: r.stdout };
}
