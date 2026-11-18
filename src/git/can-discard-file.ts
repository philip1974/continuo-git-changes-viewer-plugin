import type { SectionKind } from './can-stage-hunk';
import { isUnmerged, type FileChange } from './status-scanner';

export function canDiscardFile(change: FileChange, section: SectionKind): boolean {
  if (change.inoperable) return false;
  if (section !== 'changed') return false;
  // 未合并的路径(`UD` / `DD` 的 Y 是 D):`git checkout -- <path>` 只会失败("path is unmerged")
  if (isUnmerged(change)) return false;
  // T(类型变更):`git checkout --` 把工作树还原成 index 里的那个条目(实测文件 ↔ 符号链接两个方向)
  return change.statusY === 'M' || change.statusY === 'D' || change.statusY === 'T';
}
