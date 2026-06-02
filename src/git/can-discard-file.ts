import type { SectionKind } from './can-stage-hunk';
import type { FileChange } from './status-scanner';

export function canDiscardFile(change: FileChange, section: SectionKind): boolean {
  if (section !== 'changed') return false;
  return change.statusY === 'M' || change.statusY === 'D';
}
