import { describe, expect, it } from 'vitest';
import { canDiscardFile } from '../../git/can-discard-file';
import { canStageFile } from '../../git/can-stage-file';
import { canUnstageFile } from '../../git/can-unstage-file';
import { isUnmerged, type FileChange, type PorcelainStatusCode } from '../../git/status-scanner';

function change(partial: Partial<FileChange>): FileChange {
  return {
    path: 'a.ts',
    status: 'M',
    statusX: ' ',
    statusY: 'M',
    kind: 'text',
    ...partial,
  };
}

describe('file-level write-op eligibility', () => {
  it('T12 stages Untracked rows only with Stage', () => {
    const untracked = change({ status: 'U', statusX: '?', statusY: '?' });
    expect(canStageFile(untracked, 'untracked')).toBe(true);
    expect(canDiscardFile(untracked, 'untracked')).toBe(false);
    expect(canUnstageFile(untracked, 'untracked')).toBe(false);
  });

  it('T13 stages and discards Changed M rows', () => {
    const modified = change({ statusX: ' ', statusY: 'M' });
    expect(canStageFile(modified, 'changed')).toBe(true);
    expect(canDiscardFile(modified, 'changed')).toBe(true);
  });

  it('T14 stages and discards Changed D rows', () => {
    const deleted = change({ status: 'D', statusX: ' ', statusY: 'D' });
    expect(canStageFile(deleted, 'changed')).toBe(true);
    expect(canDiscardFile(deleted, 'changed')).toBe(true);
  });

  it('T15 does not show Changed A/R/C action buttons in v0.3.4', () => {
    expect(canStageFile(change({ status: 'A', statusY: 'A' }), 'changed')).toBe(false);
    expect(canStageFile(change({ status: 'R', statusX: 'R', statusY: ' ' }), 'changed')).toBe(false);
    expect(canStageFile(change({ status: 'R', statusX: 'C', statusY: ' ' }), 'changed')).toBe(false);
  });

  it('T16 unstages Staged M/A/D rows', () => {
    expect(canUnstageFile(change({ statusX: 'M', statusY: ' ' }), 'staged')).toBe(true);
    expect(canUnstageFile(change({ status: 'A', statusX: 'A', statusY: ' ' }), 'staged')).toBe(true);
    expect(canUnstageFile(change({ status: 'D', statusX: 'D', statusY: ' ' }), 'staged')).toBe(true);
  });

  it('T17 does not unstage R/C rows in v0.3.4', () => {
    expect(canUnstageFile(change({ status: 'R', statusX: 'R', statusY: ' ' }), 'staged')).toBe(false);
    expect(canUnstageFile(change({ status: 'R', statusX: 'C', statusY: ' ' }), 'staged')).toBe(false);
  });

  it('T18 disables file ops in the wrong section', () => {
    expect(canStageFile(change({ statusX: 'M', statusY: ' ' }), 'staged')).toBe(false);
    expect(canUnstageFile(change({ statusX: ' ', statusY: 'M' }), 'changed')).toBe(false);
    expect(canDiscardFile(change({ statusX: 'M', statusY: ' ' }), 'staged')).toBe(false);
  });

  it('T19 leaves clean status columns without action buttons', () => {
    const cleanish = change({ statusX: ' ', statusY: ' ' });
    expect(canStageFile(cleanish, 'changed')).toBe(false);
    expect(canUnstageFile(cleanish, 'staged')).toBe(false);
    expect(canDiscardFile(cleanish, 'changed')).toBe(false);
  });

  it('T20 preserves binary M/D file-level eligibility', () => {
    expect(canStageFile(change({ kind: 'binary', statusY: 'M' }), 'changed')).toBe(true);
    expect(canDiscardFile(change({ kind: 'binary', statusY: 'M' }), 'changed')).toBe(true);
    expect(canStageFile(change({ kind: 'binary', status: 'D', statusY: 'D' }), 'changed')).toBe(true);
  });

  it('T30 a type change (`T`) keeps the file-level actions of a modification: Stage / Discard in Changes, Unstage in Staged', () => {
    for (const row of [change({ statusX: ' ', statusY: 'T' }), change({ status: 'A', statusX: 'A', statusY: 'T' }), change({ statusX: 'M', statusY: 'T' })]) {
      expect(canStageFile(row, 'changed')).toBe(true);
      expect(canDiscardFile(row, 'changed')).toBe(true);
    }
    expect(canUnstageFile(change({ statusX: 'T', statusY: ' ' }), 'staged')).toBe(true);
    expect(canUnstageFile(change({ statusX: 'T', statusY: 'M' }), 'staged')).toBe(true);
  });
  // git-status(1) 的未合并表:DD AU UD UA DU AA UU
  const UNMERGED = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'] as const;
  const xy = (code: string) => change({ statusX: code[0] as PorcelainStatusCode, statusY: code[1] as PorcelainStatusCode });

  it('T31 an unmerged path (DD AU UD UA DU AA UU) has no file-level Unstage and no Discard in any section: unstaging silently drops the conflict stages, and a checkout of an unmerged path can only fail', () => {
    for (const code of UNMERGED) {
      expect(isUnmerged(xy(code)), code).toBe(true);
      for (const section of ['staged', 'changed', 'untracked'] as const) {
        expect(canUnstageFile(xy(code), section), `${code} ${section}`).toBe(false);
        expect(canDiscardFile(xy(code), section), `${code} ${section}`).toBe(false);
      }
    }
    // 不是未合并的组合不受影响
    for (const code of ['M ', 'A ', 'D ', 'AM', 'AD', 'MM', ' M', ' D', 'MD']) expect(isUnmerged(xy(code)), code).toBe(false);
    expect(canUnstageFile(xy('AM'), 'staged')).toBe(true);
    expect(canUnstageFile(xy('AD'), 'staged')).toBe(true);
    expect(canDiscardFile(xy('AD'), 'changed')).toBe(true);
    expect(canDiscardFile(xy('MD'), 'changed')).toBe(true);
  });

  it('T32 Stage on an unmerged path is exactly what it was — offered for UD and DD (a deleted side), nowhere else: nothing is opened up, nothing taken away (the panel words it as marking the conflict resolved)', () => {
    expect(UNMERGED.filter((code) => canStageFile(xy(code), 'changed'))).toEqual(['DD', 'UD']);
    for (const code of UNMERGED) expect(canStageFile(xy(code), 'staged'), code).toBe(false);
  });

  it('T33 an intent-to-add entry (` A`, from `git add -N`) is listed in Changes with no file-level action at all', () => {
    const ita = change({ status: 'A', statusX: ' ', statusY: 'A' });
    for (const section of ['staged', 'changed', 'untracked'] as const) {
      expect(canStageFile(ita, section)).toBe(false);
      expect(canUnstageFile(ita, section)).toBe(false);
      expect(canDiscardFile(ita, section)).toBe(false);
    }
  });
});
