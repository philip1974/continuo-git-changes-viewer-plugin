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
});
