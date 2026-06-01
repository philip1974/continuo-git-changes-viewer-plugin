import type { DiffResult } from './diff-fetcher';
import { isPathSafeForPatch } from './hunk-patch';
import { deriveFileStatus, type FileChange } from './status-scanner';

export type SectionKind = 'staged' | 'changed' | 'untracked';

export function canStageHunk(
  change: FileChange | null,
  diff: DiffResult | null,
  section: SectionKind,
): boolean {
  if (!change || !diff) return false;
  if (section !== 'changed') return false;
  if (change.kind !== 'text') return false;
  if (!diff.ok) return false;
  if (diff.isUntracked) return false;
  if (change.statusY === ' ' || change.statusY === '?') return false;
  if (deriveFileStatus(change) !== 'M') return false;
  return isPathSafeForPatch(change.path);
}
