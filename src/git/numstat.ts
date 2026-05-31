import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';

export interface NumstatEntry {
  readonly isBinary: boolean;
  readonly add: number | null;
  readonly del: number | null;
}

export function parseNumstat(stdout: string): Map<string, NumstatEntry> {
  const out = new Map<string, NumstatEntry>();
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const [addRaw, delRaw, path] = record.split('\t');
    if (!addRaw || !delRaw || !path) continue;
    const isBinary = addRaw === '-' && delRaw === '-';
    out.set(path, {
      isBinary,
      add: isBinary ? null : Number(addRaw),
      del: isBinary ? null : Number(delRaw),
    });
  }
  return out;
}

export async function loadNumstat(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<Map<string, NumstatEntry>> {
  const r = await gitExec(app, repoRoot, ['diff', '--numstat', '-z', 'HEAD']);
  if (r.exitCode !== 0) return new Map();
  return parseNumstat(r.stdout);
}
