import { describe, expect, it, vi } from 'vitest';
import {
  cacheKey,
  createGitStore,
  firstSelectableEntry,
} from '../../state/git-store';
import type { DiffResult } from '../../git/diff-fetcher';
import type { FileChange } from '../../git/status-scanner';

const changed: FileChange = { path: 'changed.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' };
const staged: FileChange = { path: 'staged.ts', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' };
const partial: FileChange = { path: 'partial.ts', status: 'M', statusX: 'M', statusY: 'M', kind: 'text' };
const untracked: FileChange = { path: 'notes.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' };

const diffA: DiffResult = { ok: true, path: 'changed.ts', original: '', modified: '', unifiedDiff: 'a', isUntracked: false };
const diffB: DiffResult = { ok: true, path: 'partial.ts', original: '', modified: '', unifiedDiff: 'b', isUntracked: false };

describe('git store refresh reconciliation', () => {
  it('T15 firstSelectableEntry priority is Changed > Staged > Untracked', () => {
    expect(firstSelectableEntry([staged, changed, untracked])).toEqual({
      path: 'changed.ts',
      mode: 'changed',
    });
    expect(firstSelectableEntry([staged, untracked])).toEqual({
      path: 'staged.ts',
      mode: 'staged',
    });
    expect(firstSelectableEntry([untracked])).toEqual({
      path: 'notes.txt',
      mode: 'changed',
    });
  });

  it('T16 refresh preserves selected mode when still valid', async () => {
    const store = createGitStore({
      load: vi.fn(async () => ({ repoRoot: '/repo', changes: [partial] })),
    });
    store.setState({ selected: { path: 'partial.ts', mode: 'staged' } });

    await store.getState().refresh();

    expect(store.getState().selected).toEqual({ path: 'partial.ts', mode: 'staged' });
  });

  it('T17 refresh falls back from invalid staged mode to changed mode for same path', async () => {
    const store = createGitStore({
      load: vi.fn(async () => ({
        repoRoot: '/repo',
        changes: [{ ...partial, statusX: ' ' as const, statusY: 'M' as const }],
      })),
    });
    store.setState({ selected: { path: 'partial.ts', mode: 'staged' } });

    await store.getState().refresh();

    expect(store.getState().selected).toEqual({ path: 'partial.ts', mode: 'changed' });
  });

  it('T18 refresh falls back when selected path is gone', async () => {
    const store = createGitStore({
      load: vi.fn(async () => ({ repoRoot: '/repo', changes: [changed] })),
    });
    store.setState({ selected: { path: 'gone.ts', mode: 'changed' } });

    await store.getState().refresh();

    expect(store.getState().selected).toEqual({ path: 'changed.ts', mode: 'changed' });
  });

  it('T19 refresh drops every cache entry except the one on screen — the other mode of the selected path, other paths and vanished paths alike (see git-store T7); the one on screen stays, marked as being refreshed (git-store T17)', async () => {
    const store = createGitStore({
      load: vi.fn(async () => ({ repoRoot: '/repo', changes: [changed, partial] })),
    });
    store.setState({
      selected: { path: 'partial.ts', mode: 'staged' },
      diffCache: new Map<string, DiffResult>([
        [cacheKey('changed.ts', 'changed'), diffA],
        [cacheKey('partial.ts', 'staged'), diffB],
        [cacheKey('partial.ts', 'changed'), diffB],
        [cacheKey('gone.ts', 'changed'), { ...diffA, path: 'gone.ts' }],
      ]),
    });

    await store.getState().refresh();

    expect(store.getState().selected).toEqual({ path: 'partial.ts', mode: 'staged' });
    expect([...store.getState().diffCache.keys()]).toEqual([cacheKey('partial.ts', 'staged')]);
    expect(store.getState().diffRefreshingKey).toBe(cacheKey('partial.ts', 'staged'));
  });
});
