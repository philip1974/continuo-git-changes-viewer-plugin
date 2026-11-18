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

  // `git rm --cached f`:同一路径两条记录——`D  f`(Staged)与 `?? f`(Untracked,mode 'changed')
  describe('one path listed twice (`D  f` and `?? f` after `git rm --cached f`)', () => {
    const stagedDeletion: FileChange = { path: 'f.txt', status: 'D', statusX: 'D', statusY: ' ', kind: 'text' };
    const untracked: FileChange = { path: 'f.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' };
    const other: FileChange = { path: 'z.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' };
    const setup = (changes: FileChange[] = [stagedDeletion, untracked]) => {
      const fetchDiff = vi.fn(async (_root: string, c: FileChange): Promise<DiffResult> => ({
        ok: true, path: c.path, original: '', modified: c.statusX === '?' ? 'working tree\n' : '', unifiedDiff: '', isUntracked: c.statusX === '?',
      }));
      const store = createGitStore({ fetchDiff, load: async () => ({ repoRoot: '/repo', changes }) });
      store.setState({ repoRoot: '/repo', changes });
      return { store, fetchDiff };
    };

    it('T20 each row loads the diff of its own record: (path, changed) → the untracked record, (path, staged) → the staged deletion; the two cache entries are independent', async () => {
      const { store, fetchDiff } = setup();

      await store.getState().loadDiff('f.txt', 'changed');
      await store.getState().loadDiff('f.txt', 'staged');

      expect(fetchDiff).toHaveBeenNthCalledWith(1, '/repo', untracked, 'changed');
      expect(fetchDiff).toHaveBeenNthCalledWith(2, '/repo', stagedDeletion, 'staged');
      expect(store.getState().diffCache.get(cacheKey('f.txt', 'changed'))).toMatchObject({ isUntracked: true, modified: 'working tree\n' });
      expect(store.getState().diffCache.get(cacheKey('f.txt', 'staged'))).toMatchObject({ isUntracked: false });
      // 该区没有这个路径的行:不取 diff(不会拿另一个区的记录顶替)
      const onlyStaged = setup([stagedDeletion]);
      await onlyStaged.store.getState().loadDiff('f.txt', 'changed');
      expect(onlyStaged.fetchDiff).not.toHaveBeenCalled();
      // 记录的先后顺序不影响
      const reversed = setup([untracked, stagedDeletion]);
      await reversed.store.getState().loadDiff('f.txt', 'staged');
      expect(reversed.fetchDiff).toHaveBeenCalledWith('/repo', stagedDeletion, 'staged');
    });

    it('T21 a refresh keeps the untracked row selected (it used to jump to the Staged row of the same path), and keeps the staged row selected as well', async () => {
      const { store } = setup([other, stagedDeletion, untracked]);

      store.getState().selectFile('f.txt', 'changed');
      await store.getState().refresh();
      expect(store.getState().selected).toEqual<SelectedRef>({ path: 'f.txt', mode: 'changed' });

      store.getState().selectFile('f.txt', 'staged');
      await store.getState().refresh();
      expect(store.getState().selected).toEqual<SelectedRef>({ path: 'f.txt', mode: 'staged' });
    });

    it('T22 when the selected row is gone but the other record of that path remains, selection moves to it', async () => {
      const changes = [other, stagedDeletion, untracked];
      const store = createGitStore({ load: async () => ({ repoRoot: '/repo', changes: [other, stagedDeletion] }) });
      store.setState({ repoRoot: '/repo', changes, selected: { path: 'f.txt', mode: 'changed' } });
      await store.getState().refresh();
      expect(store.getState().selected).toEqual<SelectedRef>({ path: 'f.txt', mode: 'staged' });
    });

    it('T23 inoperable records stay unselectable in either section; an ordinary twice-listed path next to them is selectable', () => {
      const odd: FileChange = { path: 'c:x', status: 'D', statusX: 'D', statusY: ' ', kind: 'text', inoperable: true };
      const oddUntracked: FileChange = { path: 'c:x', status: 'U', statusX: '?', statusY: '?', kind: 'text', inoperable: true };
      const { store } = setup([odd, oddUntracked, stagedDeletion, untracked]);
      store.getState().selectFile('c:x', 'staged');
      store.getState().selectFile('c:x', 'changed');
      expect(store.getState().selected).toBeNull();
      store.getState().selectFile('f.txt', 'changed');
      expect(store.getState().selected).toEqual<SelectedRef>({ path: 'f.txt', mode: 'changed' });
    });
  });
});
