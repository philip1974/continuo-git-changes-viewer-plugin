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
});
