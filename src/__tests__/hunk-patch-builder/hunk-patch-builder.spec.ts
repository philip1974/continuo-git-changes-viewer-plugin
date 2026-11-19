import { describe, expect, it } from 'vitest';
import {
  buildHunkPatch,
  extractHunkPatchFromUnifiedDiff,
  hasUndecodableText,
  isHunkPatchableDiff,
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

  // 扩展头决定这个 diff 能不能按 hunk 拆:buildHunkPatch 只写 `diff --git` / `---` / `+++` + 一个 hunk,丢掉 mode 头。
  const section = (path: string, header: string[], hunk: string[]) =>
    [`diff --git a/${path} b/${path}`, ...header, ...hunk].join('\n');
  const typeChange =
    `${section('f', ['deleted file mode 100644', 'index 5626abf..0000000', '--- a/f', '+++ /dev/null'], ['@@ -1 +0,0 @@', '-one'])}\n` +
    `${section('f', ['new file mode 120000', 'index 0000000..8681f8b', '--- /dev/null', '+++ b/f'], ['@@ -0,0 +1 @@', '+base', '\\ No newline at end of file'])}\n`;

  it('T5 a diff is hunk-patchable only when it is one section about one regular file or one symbolic link that stays what it is', () => {
    const ok = (header: string[]) => isHunkPatchableDiff(`${section('f', [...header, '--- a/f', '+++ b/f'], ['@@ -1 +1,2 @@', ' x', '+y'])}\n`);
    expect(ok(['index 587be6b..b77b4eb 100644'])).toBe(true);
    expect(ok(['old mode 100644', 'new mode 100755', 'index 587be6b..b77b4eb'])).toBe(true);
    expect(ok(['index 8681f8b..27fa349 120000'])).toBe(true);
    // 只有 hunk、没有头(单元测试里的写法):没有理由拒绝
    expect(isHunkPatchableDiff('@@ -1 +1 @@\n-old\n+new\n')).toBe(true);

    expect(isHunkPatchableDiff(typeChange)).toBe(false);
    // 两段,哪怕每段看起来都是普通修改
    const plain = section('f', ['index 587be6b..b77b4eb 100644', '--- a/f', '+++ b/f'], ['@@ -1 +1,2 @@', ' x', '+y']);
    expect(isHunkPatchableDiff(`${plain}\n${plain}\n`)).toBe(false);
    expect(ok(['new file mode 100644', 'index 0000000..b77b4eb'])).toBe(false);
    expect(ok(['deleted file mode 100644', 'index 587be6b..0000000'])).toBe(false);
    expect(ok(['index 2c943cc..f45b83e 160000'])).toBe(false);
    expect(ok(['old mode 100644', 'new mode 120000', 'index 587be6b..b77b4eb'])).toBe(false);
    expect(ok(['old mode 160000', 'new mode 100644', 'index 587be6b..b77b4eb'])).toBe(false);
    // 未合并路径的 combined diff
    expect(isHunkPatchableDiff('diff --cc f\nindex 1111111,2222222..0000000\n--- a/f\n+++ b/f\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n')).toBe(false);
  });

  it('T6 the same words inside file content do not count: content lines always carry a +, - or space prefix', () => {
    const diff = `${section('f', ['index 587be6b..b77b4eb 100644', '--- a/f', '+++ b/f'], ['@@ -1,2 +1,4 @@', ' diff --git a/x b/x', '+new file mode 120000', '+index 1..2 160000', '-deleted file mode 100644', ' old mode 160000'])}\n`;
    expect(isHunkPatchableDiff(diff)).toBe(true);
  });

  it('T7 no patch is built from a diff that is not hunk-patchable, whichever hunk is asked for', () => {
    const lines = typeChange.split('\n');
    const hunks = lines.map((l, i) => (l.startsWith('@@') ? i : -1)).filter((i) => i >= 0);
    expect(hunks).toHaveLength(2);
    for (const i of hunks) expect(extractHunkPatchFromUnifiedDiff('f', typeChange, i)).toBeNull();
  });
  // 宿主按 UTF-8 解码 git 的输出:非法字节 → U+FFFD,补丁写回去的是 EF BF BD,不是原来的字节
  it('T8 a diff whose text contains U+FFFD (a byte that was not valid UTF-8, or the character itself) is not hunk-patchable, wherever it sits — an added, removed or context line — and no patch is built from it', () => {
    const clean = ['diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ' ctx', '-old', '+new', ''].join('\n');
    expect(hasUndecodableText(clean)).toBe(false);
    expect(isHunkPatchableDiff(clean)).toBe(true);
    for (const line of [' ctx', '-old', '+new']) {
      const diff = clean.replace(line, `${line} caf\uFFFD`);
      expect(hasUndecodableText(diff), line).toBe(true);
      expect(isHunkPatchableDiff(diff), line).toBe(false);
      expect(extractHunkPatchFromUnifiedDiff('f', diff, 4), line).toBeNull();
    }
    // 其它非 ASCII 文本不受影响
    const utf8 = clean.replace('+new', '+café 한글 \u{1F600}');
    expect(isHunkPatchableDiff(utf8)).toBe(true);
    expect(extractHunkPatchFromUnifiedDiff('f', utf8, 4)).toContain('+café 한글 \u{1F600}\n');
  });
});
