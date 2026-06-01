import { describe, expect, it } from 'vitest';
import {
  buildHunkPatch,
  extractHunkPatchFromUnifiedDiff,
  isPathSafeForPatch,
} from '../../git/hunk-patch';

describe('hunk patch builder', () => {
  it('T1 builds a minimal git-apply patch with one hunk and a trailing LF', () => {
    expect(
      buildHunkPatch({
        filePath: 'src/a.ts',
        hunkHeader: '@@ -1,2 +1,2 @@',
        hunkLines: [' old', '-bad', '+good'],
      }),
    ).toBe(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,2 +1,2 @@',
        ' old',
        '-bad',
        '+good',
        '',
      ].join('\n'),
    );
  });

  it('T2 supports paths with spaces and unicode', () => {
    expect(isPathSafeForPatch('docs/hello world/한글 file.md')).toBe(true);
    expect(
      buildHunkPatch({
        filePath: 'docs/hello world/한글 file.md',
        hunkHeader: '@@ -1 +1 @@',
        hunkLines: ['-old', '+new'],
      }),
    ).toContain('diff --git a/docs/hello world/한글 file.md b/docs/hello world/한글 file.md');
  });

  it('T3 rejects path characters that require Git C-quoting', () => {
    expect(isPathSafeForPatch('quote"file.ts')).toBe(false);
    expect(isPathSafeForPatch('tab\tfile.ts')).toBe(false);
    expect(isPathSafeForPatch('slash\\file.ts')).toBe(false);
    expect(isPathSafeForPatch('new\nfile.ts')).toBe(false);
  });

  it('T4 extracts only the requested hunk from a multi-hunk unified diff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      '@@ -20,2 +20,3 @@',
      ' twenty',
      '+twenty-one',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    expect(extractHunkPatchFromUnifiedDiff('src/a.ts', diff, 8)).toBe(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -20,2 +20,3 @@',
        ' twenty',
        '+twenty-one',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
  });
});
