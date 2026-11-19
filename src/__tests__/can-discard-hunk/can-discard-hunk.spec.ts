import { describe, expect, it } from 'vitest';
import { canDiscardHunk } from '../../git/can-discard-hunk';
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
    statusX: ' ',
    statusY: 'M',
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

describe('canDiscardHunk', () => {
  it('T4 disables missing change or missing diff', () => {
    expect(canDiscardHunk(null, okDiff, 'changed')).toBe(false);
    expect(canDiscardHunk(change({}), null, 'changed')).toBe(false);
  });

  it('T5 enables changed text M hunks for plain working-tree modifications', () => {
    expect(canDiscardHunk(change({ statusX: ' ', statusY: 'M' }), okDiff, 'changed')).toBe(true);
  });

  it('T6 enables changed text M hunks for MM files without touching staged hunks', () => {
    expect(canDiscardHunk(change({ statusX: 'M', statusY: 'M' }), okDiff, 'changed')).toBe(true);
  });

  it('T7 disables staged, untracked, and staged-only sections', () => {
    expect(canDiscardHunk(change({ statusX: 'M', statusY: 'M' }), okDiff, 'staged')).toBe(false);
    expect(canDiscardHunk(change({ status: 'U', statusX: '?', statusY: '?' }), okDiff, 'untracked')).toBe(false);
    expect(canDiscardHunk(change({ statusX: 'M', statusY: ' ' }), okDiff, 'changed')).toBe(false);
  });

  it('T8 enables the unstaged modification of a staged new file (`AM`, shown as an index → working-tree diff since the per-section views); RM and CM hybrid rows stay disabled', () => {
    expect(canDiscardHunk(change({ status: 'A', statusX: 'A', statusY: 'M' }), okDiff, 'changed')).toBe(true);
    expect(canDiscardHunk(change({ status: 'A', statusX: 'A', statusY: 'M' }), okDiff, 'staged')).toBe(false);
    expect(canDiscardHunk(change({ status: 'A', statusX: 'A', statusY: 'D' }), okDiff, 'changed')).toBe(false);
    expect(canDiscardHunk(change({ status: 'R', statusX: 'R', statusY: 'M' }), okDiff, 'changed')).toBe(false);
    expect(canDiscardHunk(change({ status: 'R', statusX: 'C', statusY: 'M' }), okDiff, 'changed')).toBe(false);
  });

  it('T9 disables binary, too-large, untracked diffs, and unsafe paths', () => {
    expect(canDiscardHunk(change({ kind: 'binary' }), okDiff, 'changed')).toBe(false);
    expect(canDiscardHunk(change({}), {
      ok: false,
      reason: 'too-large',
      path: 'src/a.ts',
      exactCommand: 'git diff -- src/a.ts',
    }, 'changed')).toBe(false);
    expect(canDiscardHunk(change({}), { ...okDiff, isUntracked: true }, 'changed')).toBe(false);
    expect(canDiscardHunk(change({ path: 'quote"file.ts' }), okDiff, 'changed')).toBe(false);
    expect(canDiscardHunk(change({ path: 'tab\tfile.ts' }), okDiff, 'changed')).toBe(false);
  });

  it('T20 disables a type change (`T` on this section\'s side): its diff is a deletion plus an addition, not hunks of one file', () => {
    expect(canDiscardHunk(change({ statusX: ' ', statusY: 'T' }), okDiff, 'changed')).toBe(false);
    expect(canDiscardHunk(change({ status: 'A', statusX: 'A', statusY: 'T' }), okDiff, 'changed')).toBe(false);
    expect(canDiscardHunk(change({ statusX: 'M', statusY: 'T' }), okDiff, 'changed')).toBe(false);
  });

  it('T21 whatever the status says, disables diffs that cannot be split into hunks (type change in two sections, new / deleted entry, submodule entry) and keeps chmod + edit and a retargeted symbolic link', () => {
    const row = change({ statusX: ' ', statusY: 'M' });
    expect(canDiscardHunk(row, withDiff(TYPE_CHANGE), 'changed')).toBe(false);
    expect(canDiscardHunk(row, withDiff(GITLINK), 'changed')).toBe(false);
    expect(canDiscardHunk(row, withDiff(CHMOD), 'changed')).toBe(true);
    expect(canDiscardHunk(row, withDiff(RETARGET), 'changed')).toBe(true);
  });
  it('T22 disables a diff whose text contains U+FFFD (bytes that were not valid UTF-8): the patch would write the replacement character back instead of the original bytes', () => {
    const row = change({ statusX: ' ', statusY: 'M' });
    expect(canDiscardHunk(row, withDiff(CHMOD), 'changed')).toBe(true);
    expect(canDiscardHunk(row, withDiff(CHMOD.replace('+y', '+caf\uFFFD')), 'changed')).toBe(false);
    expect(canDiscardHunk(row, withDiff(CHMOD.replace(' x', ' na\uFFFDve')), 'changed')).toBe(false);
  });
});
