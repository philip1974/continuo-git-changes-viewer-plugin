export interface HunkInput {
  readonly filePath: string;
  readonly hunkHeader: string;
  readonly hunkLines: readonly string[];
}

export function isPathSafeForPatch(path: string): boolean {
  return !/[\n\r\t"\\]/.test(path);
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

export function extractHunkPatchFromUnifiedDiff(
  filePath: string,
  unifiedDiff: string,
  hunkLineIndex: number,
): string | null {
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
