import type { SectionKind } from './can-stage-hunk';
import type { FileChange } from './status-scanner';

export function canStageFile(change: FileChange, section: SectionKind): boolean {
  if (change.inoperable) return false;
  if (section === 'staged') return false;
  if (section === 'untracked') return change.statusX === '?' || change.statusY === '?';
  // T(类型变更):`git add` 记下新的条目,与修改同样处理
  return change.statusY === 'M' || change.statusY === 'D' || change.statusY === 'T';
}
