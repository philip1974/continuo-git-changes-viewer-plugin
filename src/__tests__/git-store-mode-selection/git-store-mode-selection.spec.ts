import { describe, expect, it, vi } from 'vitest';
import {
  cacheKey,
  createGitStore,
  type SelectedRef,
} from '../../state/git-store';
import type { DiffResult } from '../../git/diff-fetcher';
import type { FileChange } from '../../git/status-scanner';

const change: FileChange = {
  path: 'a.ts',
  status: 'M',
  statusX: 'M',
  statusY: 'M',
  kind: 'text',
};

const diff: DiffResult = {
  ok: true,
  path: 'a.ts',
  original: 'old',
  modified: 'new',
  unifiedDiff: 'diff',
  isUntracked: false,
};

describe('git store mode selection', () => {
  it('T11 starts with selected=null', () => {
    expect(createGitStore().getState().selected).toBeNull();
  });

  it('T12 selectFile stores structured path+mode', () => {
    const store = createGitStore();

    store.getState().selectFile('a.ts', 'staged');
    expect(store.getState().selected).toEqual<SelectedRef>({
      path: 'a.ts',
      mode: 'staged',
    });
  });

  it('T13 loadDiff stores staged and changed cache entries independently', async () => {
    const fetchDiff = vi.fn(async () => diff);
    const store = createGitStore({ fetchDiff });
    store.setState({ repoRoot: '/repo', changes: [change] });

    await store.getState().loadDiff('a.ts', 'staged');
    await store.getState().loadDiff('a.ts', 'changed');

    expect(fetchDiff).toHaveBeenNthCalledWith(1, '/repo', change, 'staged');
    expect(fetchDiff).toHaveBeenNthCalledWith(2, '/repo', change, 'changed');
    expect(store.getState().diffCache.has(cacheKey('a.ts', 'staged'))).toBe(true);
    expect(store.getState().diffCache.has(cacheKey('a.ts', 'changed'))).toBe(true);
  });

  it('T14 cache hits are scoped by mode', async () => {
    const fetchDiff = vi.fn(async () => diff);
    const store = createGitStore({ fetchDiff });
    store.setState({ repoRoot: '/repo', changes: [change] });

    await store.getState().loadDiff('a.ts', 'staged');
    await store.getState().loadDiff('a.ts', 'staged');

    expect(fetchDiff).toHaveBeenCalledTimes(1);
  });
});
