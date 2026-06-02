import type { SectionKind } from './can-stage-hunk';
import type { FileChange } from './status-scanner';

export function canUnstageFile(change: FileChange, section: SectionKind): boolean {
  if (section !== 'staged') return false;
  return change.statusX === 'M' || change.statusX === 'A' || change.statusX === 'D';
}
