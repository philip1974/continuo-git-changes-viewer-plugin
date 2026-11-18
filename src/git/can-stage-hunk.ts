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
  if (change.inoperable) return false;
  if (section !== 'changed') return false;
  if (change.kind !== 'text') return false;
  if (!diff.ok) return false;
  if (diff.isUntracked) return false;
  if (change.statusY === ' ' || change.statusY === '?') return false;
  // `AM`(已暂存的新文件又有未暂存修改):Changes 区显示的是 index → 工作树的增量,与 `MM` 同样可按 hunk 暂存
  const stagedNewThenModified = change.statusX === 'A' && change.statusY === 'M';
  if (deriveFileStatus(change) !== 'M' && !stagedNewThenModified) return false;
  return isPathSafeForPatch(change.path);
}
