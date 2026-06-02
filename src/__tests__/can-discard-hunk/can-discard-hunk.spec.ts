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

  it('T8 disables AM, RM, and CM hybrid rows for v0.3.2 M-only scope', () => {
    expect(canDiscardHunk(change({ status: 'A', statusX: 'A', statusY: 'M' }), okDiff, 'changed')).toBe(false);
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
});
