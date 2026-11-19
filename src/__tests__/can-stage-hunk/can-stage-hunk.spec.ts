import { describe, expect, it } from 'vitest';
import { canStageHunk } from '../../git/can-stage-hunk';
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

describe('canStageHunk', () => {
  it('T8 enables pure modified text files in the Changed section', () => {
    expect(canStageHunk(change({}), okDiff, 'changed')).toBe(true);
  });

  it('T9 disables untracked and staged sections', () => {
    expect(canStageHunk(change({ status: 'U', statusX: '?', statusY: '?' }), okDiff, 'untracked')).toBe(false);
    expect(canStageHunk(change({ statusX: 'M', statusY: ' ' }), okDiff, 'staged')).toBe(false);
  });

  it('T10 disables added, deleted, and renamed rows', () => {
    expect(canStageHunk(change({ status: 'A', statusX: ' ', statusY: 'A' }), okDiff, 'changed')).toBe(false);
    expect(canStageHunk(change({ status: 'D', statusX: ' ', statusY: 'D' }), okDiff, 'changed')).toBe(false);
    expect(canStageHunk(change({ status: 'R', statusX: 'R', statusY: ' ' }), okDiff, 'changed')).toBe(false);
  });

  it('T11 disables binary and too-large diffs', () => {
    expect(canStageHunk(change({ kind: 'binary' }), okDiff, 'changed')).toBe(false);
    expect(canStageHunk(change({}), {
      ok: false,
      reason: 'too-large',
      path: 'src/a.ts',
      exactCommand: 'git diff -- src/a.ts',
    }, 'changed')).toBe(false);
  });

  it('T12 disables unsafe patch paths', () => {
    expect(canStageHunk(change({ path: 'quote"file.ts' }), okDiff, 'changed')).toBe(false);
    expect(canStageHunk(change({ path: 'tab\tfile.ts' }), okDiff, 'changed')).toBe(false);
    expect(canStageHunk(change({ path: 'slash\\file.ts' }), okDiff, 'changed')).toBe(false);
  });

  it('T13 enables the unstaged modification of a staged new file (`AM`): its Changes diff is an ordinary index → working-tree hunk; `AD`, `AA` and `RM` stay disabled', () => {
    expect(canStageHunk(change({ status: 'A', statusX: 'A', statusY: 'M' }), okDiff, 'changed')).toBe(true);
    expect(canStageHunk(change({ status: 'A', statusX: 'A', statusY: 'M' }), okDiff, 'staged')).toBe(false);
    expect(canStageHunk(change({ status: 'A', statusX: 'A', statusY: 'M', kind: 'binary' }), okDiff, 'changed')).toBe(false);
    expect(canStageHunk(change({ status: 'A', statusX: 'A', statusY: 'D' }), okDiff, 'changed')).toBe(false);
    expect(canStageHunk(change({ status: 'A', statusX: 'A', statusY: 'A' }), okDiff, 'changed')).toBe(false);
    expect(canStageHunk(change({ status: 'R', statusX: 'R', statusY: 'M' }), okDiff, 'changed')).toBe(false);
  });

  it('T20 disables a type change (`T` on this section\'s side): its diff is a deletion plus an addition, not hunks of one file', () => {
    expect(canStageHunk(change({ statusX: ' ', statusY: 'T' }), okDiff, 'changed')).toBe(false);
    expect(canStageHunk(change({ status: 'A', statusX: 'A', statusY: 'T' }), okDiff, 'changed')).toBe(false);
    expect(canStageHunk(change({ statusX: 'M', statusY: 'T' }), okDiff, 'changed')).toBe(false);
  });

  it('T21 whatever the status says, disables diffs that cannot be split into hunks (type change in two sections, new / deleted entry, submodule entry) and keeps chmod + edit and a retargeted symbolic link', () => {
    const row = change({ statusX: ' ', statusY: 'M' });
    expect(canStageHunk(row, withDiff(TYPE_CHANGE), 'changed')).toBe(false);
    expect(canStageHunk(row, withDiff(GITLINK), 'changed')).toBe(false);
    expect(canStageHunk(row, withDiff(CHMOD), 'changed')).toBe(true);
    expect(canStageHunk(row, withDiff(RETARGET), 'changed')).toBe(true);
  });
  it('T22 disables a diff whose text contains U+FFFD (bytes that were not valid UTF-8): the patch would write the replacement character back instead of the original bytes', () => {
    const row = change({ statusX: ' ', statusY: 'M' });
    expect(canStageHunk(row, withDiff(CHMOD), 'changed')).toBe(true);
    expect(canStageHunk(row, withDiff(CHMOD.replace('+y', '+caf\uFFFD')), 'changed')).toBe(false);
    expect(canStageHunk(row, withDiff(CHMOD.replace(' x', ' na\uFFFDve')), 'changed')).toBe(false);
  });
});
