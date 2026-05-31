import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';

export type RepoDetectionResult =
  | { ok: true; root: string }
  | {
      ok: false;
      reason: 'no-workspace' | 'not-git-root';
      root?: string;
      prefix?: string;
      message?: string;
    };

export async function detectRepo(
  app: Pick<CoPluginApp, 'workspace' | 'shell'>,
): Promise<RepoDetectionResult> {
  const root = await app.workspace.getRoot();
  if (!root) return { ok: false, reason: 'no-workspace' };

  const r = await gitExec(app, root, ['rev-parse', '--show-prefix']);
  if (r.exitCode !== 0) {
    return {
      ok: false,
      reason: 'not-git-root',
      root,
      message: r.stderr || r.stdout,
    };
  }

  const prefix = r.stdout.trim();
  if (prefix === '') return { ok: true, root };
  return { ok: false, reason: 'not-git-root', root, prefix };
}
