import { describe, expect, it } from 'vitest';
import {
  createGitStore,
  selectChanged,
  selectStaged,
  selectUntracked,
} from '../../state/git-store';
import type { FileChange } from '../../git/status-scanner';

const changes: FileChange[] = [
  { path: 'staged.ts', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' },
  { path: 'changed.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
  { path: 'partial.ts', status: 'M', statusX: 'M', statusY: 'M', kind: 'text' },
  { path: 'notes.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' },
];

describe('git store section selectors', () => {
  it('T15 returns staged rows from the X column', () => {
    expect(selectStaged({ changes })).toEqual([changes[0], changes[2]]);
  });

  it('T16 returns changed rows from the Y column, including MM partials', () => {
    expect(selectChanged({ changes })).toEqual([changes[1], changes[2]]);
  });

  it('T17 returns untracked rows from ??', () => {
    expect(selectUntracked({ changes })).toEqual([changes[3]]);
  });

  it('T18 refresh selects the first actionable Changed/Untracked row instead of a staged-only row', async () => {
    const store = createGitStore({
      load: async () => ({ repoRoot: '/repo', changes }),
    });

    await store.getState().refresh();

    expect(store.getState().selectedPath).toBe('changed.ts');
  });
});
