import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { loadNumstat, type NumstatEntry } from './numstat';

export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'U';
export type FileKind = 'text' | 'binary';

export interface FileChange {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: FileStatus;
  readonly kind: FileKind;
}

function statusFromCode(code: string): FileStatus {
  if (code === '??') return 'U';
  if (code[0] === 'R' || code[1] === 'R') return 'R';
  if (code[0] === 'A' || code[1] === 'A') return 'A';
  if (code[0] === 'D' || code[1] === 'D') return 'D';
  return 'M';
}

function kindFor(path: string, numstat: Map<string, NumstatEntry>): FileKind {
  return numstat.get(path)?.isBinary ? 'binary' : 'text';
}

export function parsePorcelainStatus(
  stdout: string,
  numstat: Map<string, NumstatEntry> = new Map(),
): FileChange[] {
  const parts = stdout.split('\0').filter((part) => part.length > 0);
  const changes: FileChange[] = [];

  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]!;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    const status = statusFromCode(code);

    if (status === 'R') {
      const oldPath = parts[++i];
      changes.push({
        path,
        ...(oldPath ? { oldPath } : {}),
        status,
        kind: kindFor(path, numstat),
      });
      continue;
    }

    changes.push({
      path,
      status,
      kind: kindFor(path, numstat),
    });
  }

  return changes;
}

export async function scanStatus(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<FileChange[]> {
  const status = await gitExec(app, repoRoot, ['status', '--porcelain=v1', '-z']);
  if (status.exitCode !== 0) return [];
  const numstat = await loadNumstat(app, repoRoot);
  return parsePorcelainStatus(status.stdout, numstat);
}
