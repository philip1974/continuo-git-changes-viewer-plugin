import type { DiffResult } from './diff-fetcher';
import type { SectionKind } from './can-stage-hunk';
import { isPathSafeForPatch } from './hunk-patch';
import type { FileChange } from './status-scanner';

export function canUnstageHunk(
  change: FileChange | null,
  diff: DiffResult | null,
  section: SectionKind,
): boolean {
  if (!change || !diff) return false;
  if (section !== 'staged') return false;
  if (change.kind !== 'text') return false;
  if (!diff.ok) return false;
  if (diff.isUntracked) return false;
  if (change.statusX !== 'M') return false;
  return isPathSafeForPatch(change.path);
}
