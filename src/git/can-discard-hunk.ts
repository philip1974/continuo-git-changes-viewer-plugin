import type { SectionKind } from './can-stage-hunk';
import type { DiffResult } from './diff-fetcher';
import { isPathSafeForPatch } from './hunk-patch';
import type { FileChange } from './status-scanner';

export function canDiscardHunk(
  change: FileChange | null,
  diff: DiffResult | null,
  section: SectionKind,
): boolean {
  if (!change || !diff) return false;
  if (section !== 'changed') return false;
  if (change.kind !== 'text') return false;
  if (!diff.ok) return false;
  if (diff.isUntracked) return false;
  if (change.statusY !== 'M') return false;
  if (change.statusX !== ' ' && change.statusX !== 'M') return false;
  return isPathSafeForPatch(change.path);
}
