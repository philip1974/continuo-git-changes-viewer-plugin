import type { SectionKind } from './can-stage-hunk';
import type { FileChange } from './status-scanner';

export function canStageFile(change: FileChange, section: SectionKind): boolean {
  if (section === 'staged') return false;
  if (section === 'untracked') return change.statusX === '?' || change.statusY === '?';
  return change.statusY === 'M' || change.statusY === 'D';
}
