import { describe, expect, it, vi } from 'vitest';
import { createGitStore } from '../../state/git-store';

describe('git viewer store', () => {
  it('T1 selectFile records selected path', () => {
    const store = createGitStore();

    store.getState().selectFile('src/a.ts', 'changed');

    expect(store.getState().selected).toEqual({
      path: 'src/a.ts',
      mode: 'changed',
    });
  });

  it('T2 clear resets state', () => {
    const store = createGitStore();
    store.setState({
      repoRoot: '/repo',
      changes: [{ path: 'a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }],
      selected: { path: 'a.ts', mode: 'changed' },
      diffCache: new Map([['changed:a.ts', { ok: true, path: 'a.ts', original: '', modified: '', unifiedDiff: 'diff', isUntracked: false }]]) as Map<string, import('../../git/diff-fetcher').DiffResult>,
      isLoading: true,
      banner: { kind: 'info', message: 'hello', dismissable: true },
    });

    store.getState().clear();

    expect(store.getState()).toMatchObject({
      repoRoot: null,
      changes: [],
      selected: null,
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

  it('T5 refresh preserves user selected path+mode if still valid (v0.3.0 GUI fix)', async () => {
    const changeA = { path: 'a.ts', status: 'M' as const, statusX: ' ' as const, statusY: 'M' as const, kind: 'text' as const };
    const changeB = { path: 'b.ts', status: 'M' as const, statusX: ' ' as const, statusY: 'M' as const, kind: 'text' as const };
    const store = createGitStore({
      load: vi.fn(async () => ({ repoRoot: '/repo', changes: [changeA, changeB] })),
    });

    store.setState({ selected: { path: 'b.ts', mode: 'changed' } });
    await store.getState().refresh();

    expect(store.getState().selected).toEqual({ path: 'b.ts', mode: 'changed' });
  });

  it('T6 refresh falls back to firstSelectableEntry if selected path no longer present', async () => {
    const changeA = { path: 'a.ts', status: 'M' as const, statusX: ' ' as const, statusY: 'M' as const, kind: 'text' as const };
    const store = createGitStore({
      load: vi.fn(async () => ({ repoRoot: '/repo', changes: [changeA] })),
    });

    store.setState({ selected: { path: 'deleted.ts', mode: 'changed' } });
    await store.getState().refresh();

    expect(store.getState().selected).toEqual({ path: 'a.ts', mode: 'changed' });
  });

  // 缓存里的 diff 是上一次 status 时的内容:已暂存的文件再次修改并 `git add`(XY 仍是 `M `)之后,
  // 留着它就会显示旧版本,而 Commit 提交的是新版本。
  it('T7 a successful refresh drops every cached diff — selected or not — and loads the selected one again', async () => {
    const changeA = { path: 'a.ts', status: 'M' as const, statusX: 'M' as const, statusY: ' ' as const, kind: 'text' as const };
    const changeB = { path: 'b.ts', status: 'M' as const, statusX: 'M' as const, statusY: ' ' as const, kind: 'text' as const };
    let version = 1;
    const fetchDiff = vi.fn(async (_root: string, c: { readonly path: string }) => ({
      ok: true as const, path: c.path, original: 'old', modified: `${c.path} v${version}`, unifiedDiff: `v${version}`, isUntracked: false,
    }));
    const store = createGitStore({
      load: vi.fn(async () => ({ repoRoot: '/repo', changes: [changeA, changeB] })),
      fetchDiff,
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const shown = (path: string) => {
      const diff = store.getState().diffCache.get(`staged:${path}`);
      return diff?.ok ? diff.modified : undefined;
    };

    await store.getState().refresh();
    store.getState().selectFile('b.ts', 'staged');
    await flush();
    store.getState().selectFile('a.ts', 'staged');
    await flush();
    expect([shown('a.ts'), shown('b.ts')]).toEqual(['a.ts v1', 'b.ts v1']);

    version = 2; // 终端里:改 b 并 `git add b`
    await store.getState().refresh();
    await flush();
    expect(store.getState().selected).toEqual({ path: 'a.ts', mode: 'staged' });
    expect([...store.getState().diffCache.keys()]).toEqual(['staged:a.ts']);
    expect(shown('a.ts')).toBe('a.ts v2');

    store.getState().selectFile('b.ts', 'staged');
    await flush();
    expect(shown('b.ts')).toBe('b.ts v2');
  });

  it('T8 selecting a row always fetches its diff again: what is shown after a click is never older than the click, even between two refreshes', async () => {
    const change = { path: 'a.ts', status: 'M' as const, statusX: ' ' as const, statusY: 'M' as const, kind: 'text' as const };
    let version = 1;
    const fetchDiff = vi.fn(async () => ({
      ok: true as const, path: 'a.ts', original: '', modified: `v${version}`, unifiedDiff: '', isUntracked: false,
    }));
    const store = createGitStore({ fetchDiff });
    store.setState({ repoRoot: '/repo', changes: [change] });

    store.getState().selectFile('a.ts', 'changed');
    await store.getState().loadDiff('a.ts', 'changed');
    expect(store.getState().diffCache.get('changed:a.ts')).toMatchObject({ modified: 'v1' });

    version = 2;
    store.getState().selectFile('a.ts', 'changed');
    // 旧内容在重新读取期间不再显示
    expect(store.getState().diffCache.has('changed:a.ts')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().diffCache.get('changed:a.ts')).toMatchObject({ modified: 'v2' });
  });
});
