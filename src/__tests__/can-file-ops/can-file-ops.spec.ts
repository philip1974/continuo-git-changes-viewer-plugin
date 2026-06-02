import { describe, expect, it } from 'vitest';
import { canDiscardFile } from '../../git/can-discard-file';
import { canStageFile } from '../../git/can-stage-file';
import { canUnstageFile } from '../../git/can-unstage-file';
import type { FileChange } from '../../git/status-scanner';

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
});
