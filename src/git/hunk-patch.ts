import { isSafeRepoRelativePath } from './path-utils';

export interface HunkInput {
  readonly filePath: string;
  readonly hunkHeader: string;
  readonly hunkLines: readonly string[];
}

export function isPathSafeForPatch(path: string): boolean {
  return !/[\n\r\t"\\]/.test(path) && isSafeRepoRelativePath(path);
}

export function buildHunkPatch(input: HunkInput): string {
  const lines = [
    `diff --git a/${input.filePath} b/${input.filePath}`,
    `--- a/${input.filePath}`,
    `+++ b/${input.filePath}`,
    input.hunkHeader,
    ...input.hunkLines,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * 这个 unified diff 能不能按 hunk 拆成补丁。buildHunkPatch 只写 `diff --git` / `---` / `+++` 加一个 hunk,
 * 扩展头(mode)全部丢掉——只有"同一个条目、类型不变、内容有增删"的 diff 才能这样处理:
 * - 多于一段 `diff --git`:类型变更(文件 ↔ 符号链接 ↔ 子模块)被 git 写成"删除 + 新增"两段。按 hunk 应用
 *   第一段会把 index 里的条目变成空的普通文件(原暂存内容被移出 index),反向应用第二段会把工作树的
 *   链接改成目标为空(实测 git 2.50 / 2.56)。
 * - `new file mode` / `deleted file mode`:条目的出现 / 消失,不是内容 hunk。
 * - `index … 160000`、非普通文件的 `old mode` / `new mode`:子模块条目——"内容"是一行 `Subproject commit`,
 *   git apply 对工作树报成功但什么都不做。
 * - `diff --cc` / `--combined`:未合并路径的合并 diff。
 * 保留:单段的普通修改、`old mode 100644` / `new mode 100755` + 内容(hunk 只动内容,mode 留给文件级操作)、
 * 目标改变的符号链接(`index … 120000`)——三者按 hunk 应用实测正确。
 * 只看行首:内容行总带 `+` / `-` / 空格前缀(diff.suppressBlankEmpty 已固定为 false),不会与这些头混淆。
 * 渲染 hunk 按钮(can*Hunk)与构造补丁(extractHunkPatchFromUnifiedDiff)两处都用它。
 */
export function isHunkPatchableDiff(unifiedDiff: string): boolean {
  let sections = 0;
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (++sections > 1) return false;
    } else if (
      line.startsWith('diff --cc ') ||
      line.startsWith('diff --combined ') ||
      line.startsWith('new file mode ') ||
      line.startsWith('deleted file mode ') ||
      /^(old|new) mode (?!100)/.test(line) ||
      /^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/.test(line)
    ) {
      return false;
    }
  }
  return true;
}

export function extractHunkPatchFromUnifiedDiff(
  filePath: string,
  unifiedDiff: string,
  hunkLineIndex: number,
): string | null {
  if (!isHunkPatchableDiff(unifiedDiff)) return null;
  const lines = unifiedDiff.split('\n');
  const hunkHeader = lines[hunkLineIndex];
  if (!hunkHeader?.startsWith('@@')) return null;

  const hunkLines: string[] = [];
  for (let i = hunkLineIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('@@')) break;
    if (line.startsWith('diff --git ')) break;
    if (i === lines.length - 1 && line === '') break;
    hunkLines.push(line);
  }

  return buildHunkPatch({
    filePath,
    hunkHeader,
    hunkLines,
  });
}
