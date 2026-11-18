import type { SectionKind } from './can-stage-hunk';
import type { DiffResult } from './diff-fetcher';
import { isHunkPatchableDiff, isPathSafeForPatch } from './hunk-patch';
import type { FileChange } from './status-scanner';

export function canDiscardHunk(
  change: FileChange | null,
  diff: DiffResult | null,
  section: SectionKind,
): boolean {
  if (!change || !diff) return false;
  if (change.inoperable) return false;
  if (section !== 'changed') return false;
  if (change.kind !== 'text') return false;
  if (!diff.ok) return false;
  if (diff.isUntracked) return false;
  if (change.statusY !== 'M') return false;
  if (!isHunkPatchableDiff(diff.unifiedDiff)) return false;
  // X === 'A':`AM`,Changes 区显示的是 index → 工作树的增量(与 `MM` 相同);R / C 仍不支持
  if (change.statusX !== ' ' && change.statusX !== 'M' && change.statusX !== 'A') return false;
  return isPathSafeForPatch(change.path);
}
