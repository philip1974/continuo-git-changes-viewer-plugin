import { describe, expect, it, vi } from 'vitest';
import { createGitStore } from '../../state/git-store';

describe('git viewer store', () => {
  it('T1 selectFile records selected path', () => {
    const store = createGitStore();

    store.getState().selectFile('src/a.ts');

    expect(store.getState().selectedPath).toBe('src/a.ts');
  });

  it('T2 clear resets state', () => {
    const store = createGitStore();
    store.setState({
      repoRoot: '/repo',
      changes: [{ path: 'a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }],
      selectedPath: 'a.ts',
      diffCache: new Map([['a.ts', { ok: true, path: 'a.ts', original: '', modified: '', unifiedDiff: 'diff', isUntracked: false }]]) as Map<string, import('../../git/diff-fetcher').DiffResult>,
      isLoading: true,
      banner: { kind: 'info', message: 'hello', dismissable: true },
    });

    store.getState().clear();

    expect(store.getState()).toMatchObject({
      repoRoot: null,
      changes: [],
      selectedPath: null,
      isLoading: false,
      banner: null,
    });
    expect(store.getState().diffCache.size).toBe(0);
  });

  it('T3 setBanner and dismissBanner update banner state', () => {
    const store = createGitStore();
    const banner = {
      kind: 'warn' as const,
      message: 'Diff too large',
      dismissable: true,
    };

    store.getState().setBanner(banner);
    expect(store.getState().banner).toEqual(banner);

    store.getState().dismissBanner();
    expect(store.getState().banner).toBeNull();
  });

  it('T4 refresh uses injected loader and replaces repo state', async () => {
    const load = vi.fn().mockResolvedValue({
      repoRoot: '/repo',
      changes: [{ path: 'a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }],
    });
    const store = createGitStore({ load });

    await store.getState().refresh();

    expect(load).toHaveBeenCalledTimes(1);
    expect(store.getState().repoRoot).toBe('/repo');
    expect(store.getState().changes).toEqual([
      { path: 'a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
    ]);
    expect(store.getState().isLoading).toBe(false);
  });

  it('T5 refresh preserves user selectedPath if file still present (v0.3.0 GUI fix)', async () => {
    const changeA = { path: 'a.ts', status: 'M' as const, statusX: ' ' as const, statusY: 'M' as const, kind: 'text' as const };
    const changeB = { path: 'b.ts', status: 'M' as const, statusX: ' ' as const, statusY: 'M' as const, kind: 'text' as const };
    const store = createGitStore({
      load: vi.fn(async () => ({ repoRoot: '/repo', changes: [changeA, changeB] })),
    });

    store.setState({ selectedPath: 'b.ts' });
    await store.getState().refresh();

    expect(store.getState().selectedPath).toBe('b.ts');
  });

  it('T6 refresh falls back to firstSelectablePath if selectedPath no longer present', async () => {
    const changeA = { path: 'a.ts', status: 'M' as const, statusX: ' ' as const, statusY: 'M' as const, kind: 'text' as const };
    const store = createGitStore({
      load: vi.fn(async () => ({ repoRoot: '/repo', changes: [changeA] })),
    });

    store.setState({ selectedPath: 'deleted.ts' });
    await store.getState().refresh();

    expect(store.getState().selectedPath).toBe('a.ts');
  });

  it('T7 refresh preserves diffCache for non-selected files still present', async () => {
    const changeA = { path: 'a.ts', status: 'M' as const, statusX: ' ' as const, statusY: 'M' as const, kind: 'text' as const };
    const changeB = { path: 'b.ts', status: 'M' as const, statusX: ' ' as const, statusY: 'M' as const, kind: 'text' as const };
    const cachedDiffA = { ok: true as const, path: 'a.ts', original: 'old', modified: 'new', unifiedDiff: 'd1', isUntracked: false };
    const cachedDiffB = { ok: true as const, path: 'b.ts', original: 'old', modified: 'new', unifiedDiff: 'd2', isUntracked: false };
    const store = createGitStore({
      load: vi.fn(async () => ({ repoRoot: '/repo', changes: [changeA, changeB] })),
    });

    store.setState({
      selectedPath: 'b.ts',
      diffCache: new Map<string, import('../../git/diff-fetcher').DiffResult>([
        ['a.ts', cachedDiffA],
        ['b.ts', cachedDiffB],
      ]),
    });

    await store.getState().refresh();

    expect(store.getState().diffCache.get('a.ts')).toBe(cachedDiffA);
    expect(store.getState().diffCache.has('b.ts')).toBe(false);
  });
});
