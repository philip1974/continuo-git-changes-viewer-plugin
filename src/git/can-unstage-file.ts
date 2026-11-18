import type { SectionKind } from './can-stage-hunk';
import { isUnmerged, type FileChange } from './status-scanner';

export function canUnstageFile(change: FileChange, section: SectionKind): boolean {
  if (change.inoperable) return false;
  if (section !== 'staged') return false;
  // 未合并的路径(`AA` / `AU` / `DD` / `DU` 的 X 也是 A / D):`git restore --staged` 以 0 退出,同时把冲突的各
  // stage 丢掉——`AA` 变成 ` M`,`AU` 直接变干净(实测 git 2.50 / 2.56),提示却只说 "Unstaged"。不提供;
  // 冲突在编辑器 / 终端里解决(FileList 的 CONFLICT 标记说明)。
  if (isUnmerged(change)) return false;
  return change.statusX === 'M' || change.statusX === 'A' || change.statusX === 'D' || change.statusX === 'T';
}
