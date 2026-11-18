import { describe, expect, it } from 'vitest';
import { canUnstageHunk } from '../../git/can-unstage-hunk';
import type { DiffResult } from '../../git/diff-fetcher';
import type { FileChange } from '../../git/status-scanner';

const okDiff: DiffResult = {
  ok: true,
  path: 'src/a.ts',
  original: 'old',
  modified: 'new',
  unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
  isUntracked: false,
};

function change(partial: Partial<FileChange>): FileChange {
  return {
    path: 'src/a.ts',
    status: 'M',
    statusX: 'M',
    statusY: ' ',
    kind: 'text',
    ...partial,
  };
}

// 不能按 hunk 拆的 diff 形态(见 hunk-patch 的 isHunkPatchableDiff)
const head = (path: string, ...extra: string[]) => [`diff --git a/${path} b/${path}`, ...extra].join('\n');
const TYPE_CHANGE = `${head('f', 'deleted file mode 100644', 'index 5626abf..0000000', '--- a/f', '+++ /dev/null', '@@ -1 +0,0 @@', '-one')}\n${head('f', 'new file mode 120000', 'index 0000000..8681f8b', '--- /dev/null', '+++ b/f', '@@ -0,0 +1 @@', '+base', '\\ No newline at end of file')}\n`;
const GITLINK = `${head('sub', 'index 2c943cc..f45b83e 160000', '--- a/sub', '+++ b/sub', '@@ -1 +1 @@', '-Subproject commit 2c943cc', '+Subproject commit f45b83e')}\n`;
const CHMOD = `${head('f', 'old mode 100644', 'new mode 100755', 'index 587be6b..b77b4eb', '--- a/f', '+++ b/f', '@@ -1 +1,2 @@', ' x', '+y')}\n`;
const RETARGET = `${head('l', 'index 8681f8b..27fa349 120000', '--- a/l', '+++ b/l', '@@ -1 +1 @@', '-base', '\\ No newline at end of file', '+other', '\\ No newline at end of file')}\n`;
const withDiff = (unifiedDiff: string): DiffResult => ({ ...okDiff, unifiedDiff } as DiffResult);

describe('canUnstageHunk', () => {
  it('T4 enables staged modified text hunks', () => {
    expect(canUnstageHunk(change({}), okDiff, 'staged')).toBe(true);
  });

  it('T5 disables changed and untracked sections', () => {
    expect(canUnstageHunk(change({ statusX: ' ', statusY: 'M' }), okDiff, 'changed')).toBe(false);
    expect(canUnstageHunk(change({ status: 'U', statusX: '?', statusY: '?' }), okDiff, 'untracked')).toBe(false);
  });

  it('T6 disables A/D/R/C because v0.3.1 is M-only', () => {
    expect(canUnstageHunk(change({ status: 'A', statusX: 'A' }), okDiff, 'staged')).toBe(false);
    expect(canUnstageHunk(change({ status: 'D', statusX: 'D' }), okDiff, 'staged')).toBe(false);
    expect(canUnstageHunk(change({ status: 'R', statusX: 'R' }), okDiff, 'staged')).toBe(false);
    expect(canUnstageHunk(change({ status: 'R', statusX: 'C' }), okDiff, 'staged')).toBe(false);
  });

  it('T7 disables binary, too-large, and unsafe paths', () => {
    expect(canUnstageHunk(change({ kind: 'binary' }), okDiff, 'staged')).toBe(false);
    expect(canUnstageHunk(change({}), {
      ok: false,
      reason: 'too-large',
      path: 'src/a.ts',
      exactCommand: 'git diff --cached -- src/a.ts',
    }, 'staged')).toBe(false);
    expect(canUnstageHunk(change({ path: 'quote"file.ts' }), okDiff, 'staged')).toBe(false);
  });

  it('T20 disables a type change (`T` on this section\'s side): its diff is a deletion plus an addition, not hunks of one file', () => {
    expect(canUnstageHunk(change({ statusX: 'T', statusY: ' ' }), okDiff, 'staged')).toBe(false);
    expect(canUnstageHunk(change({ statusX: 'T', statusY: 'M' }), okDiff, 'staged')).toBe(false);
  });

  it('T21 whatever the status says, disables diffs that cannot be split into hunks (type change in two sections, new / deleted entry, submodule entry) and keeps chmod + edit and a retargeted symbolic link', () => {
    const row = change({ statusX: 'M', statusY: ' ' });
    expect(canUnstageHunk(row, withDiff(TYPE_CHANGE), 'staged')).toBe(false);
    expect(canUnstageHunk(row, withDiff(GITLINK), 'staged')).toBe(false);
    expect(canUnstageHunk(row, withDiff(CHMOD), 'staged')).toBe(true);
    expect(canUnstageHunk(row, withDiff(RETARGET), 'staged')).toBe(true);
  });
  it('T22 disables a diff whose text contains U+FFFD (bytes that were not valid UTF-8): the patch would write the replacement character back instead of the original bytes', () => {
    const row = change({ statusX: 'M', statusY: ' ' });
    expect(canUnstageHunk(row, withDiff(CHMOD), 'staged')).toBe(true);
    expect(canUnstageHunk(row, withDiff(CHMOD.replace('+y', '+caf\uFFFD')), 'staged')).toBe(false);
    expect(canUnstageHunk(row, withDiff(CHMOD.replace(' x', ' na\uFFFDve')), 'staged')).toBe(false);
  });
});
