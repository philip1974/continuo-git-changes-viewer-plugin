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

  // 手动 Refresh、文件操作之后的 refresh 与自动刷新的 tick 可以同时在途;慢的那个晚到时不能盖掉更新的结果。
  describe('overlapping refreshes and diff loads: only the most recently started one lands', () => {
    const row = (path: string) => ({ path, status: 'M' as const, statusX: 'M' as const, statusY: ' ' as const, kind: 'text' as const });
    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
    type Loaded = Awaited<ReturnType<NonNullable<Parameters<typeof createGitStore>[0]>['load'] & {}>>;

    it('T9 a slow earlier refresh that succeeds late does not clear the failure a later refresh reported: the list stays the later one and Commit stays disabled (statusError)', async () => {
      const first = deferred<Loaded>();
      const second = deferred<Loaded>();
      const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const store = createGitStore({ load });

      const a = store.getState().refresh();
      const b = store.getState().refresh();
      second.resolve({ repoRoot: '/repo', changes: [], statusError: 'git status failed (boom)' });
      await b;
      expect(store.getState()).toMatchObject({ statusError: 'git status failed (boom)', changes: [], isLoading: false });

      first.resolve({ repoRoot: '/repo', changes: [row('old.ts')] });
      await a;
      expect(store.getState()).toMatchObject({ statusError: 'git status failed (boom)', changes: [] });
    });

    it('T10 the same for a later refresh that throws, and the other way round: an earlier refresh that fails late does not put an error over a later success', async () => {
      const first = deferred<Loaded>();
      const second = deferred<Loaded>();
      const onError = vi.fn();
      const store = createGitStore({ load: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise), onError });
      const a = store.getState().refresh();
      const b = store.getState().refresh();
      second.reject(new Error('boom'));
      await b;
      first.resolve({ repoRoot: '/repo', changes: [row('old.ts')] });
      await a;
      expect(store.getState()).toMatchObject({ statusError: 'boom', changes: [] });

      const third = deferred<Loaded>();
      const fourth = deferred<Loaded>();
      const store2 = createGitStore({ load: vi.fn().mockReturnValueOnce(third.promise).mockReturnValueOnce(fourth.promise), onError });
      const c = store2.getState().refresh();
      const d = store2.getState().refresh();
      fourth.resolve({ repoRoot: '/repo', changes: [row('new.ts')] });
      await d;
      onError.mockClear();
      third.reject(new Error('late failure'));
      await c;
      expect(store2.getState()).toMatchObject({ statusError: null, changes: [row('new.ts')] });
      expect(onError).not.toHaveBeenCalled();
    });

    it('T11 isLoading follows the latest refresh: an earlier one finishing first does not end it', async () => {
      const first = deferred<Loaded>();
      const second = deferred<Loaded>();
      const store = createGitStore({ load: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) });
      const a = store.getState().refresh();
      const b = store.getState().refresh();
      first.resolve({ repoRoot: '/repo', changes: [row('old.ts')] });
      await a;
      expect(store.getState()).toMatchObject({ isLoading: true, changes: [] });
      second.resolve({ repoRoot: '/repo', changes: [row('new.ts')] });
      await b;
      expect(store.getState()).toMatchObject({ isLoading: false, changes: [row('new.ts')] });
    });

    const diffOf = (modified: string) => ({ ok: true as const, path: 'a.ts', original: '', modified, unifiedDiff: '', isUntracked: false });
    const shownA = (store: ReturnType<typeof createGitStore>) => {
      const diff = store.getState().diffCache.get('staged:a.ts');
      return diff?.ok ? diff.modified : undefined;
    };

    it('T12 a diff read that was started before a newer click on the same row and finishes after it does not replace the newer content; a late failure of it raises no banner', async () => {
      const slow = deferred<ReturnType<typeof diffOf>>();
      const slowFailing = deferred<ReturnType<typeof diffOf>>();
      const fetchDiff = vi.fn()
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValueOnce(diffOf('v2'))
        .mockReturnValueOnce(slowFailing.promise)
        .mockResolvedValueOnce(diffOf('v3'));
      const store = createGitStore({ fetchDiff });
      store.setState({ repoRoot: '/repo', changes: [row('a.ts')] });

      store.getState().selectFile('a.ts', 'staged'); // 读取 #1(慢)
      store.getState().selectFile('a.ts', 'staged'); // 读取 #2
      await store.getState().loadDiff('a.ts', 'staged');
      expect(shownA(store)).toBe('v2');
      slow.resolve(diffOf('v1'));
      await slow.promise;
      await Promise.resolve();
      expect(shownA(store)).toBe('v2');

      store.getState().selectFile('a.ts', 'staged'); // #3(慢,之后失败)
      store.getState().selectFile('a.ts', 'staged'); // #4
      await store.getState().loadDiff('a.ts', 'staged');
      slowFailing.reject(new Error('late'));
      await slowFailing.promise.catch(() => {});
      await Promise.resolve();
      expect(shownA(store)).toBe('v3');
      expect(store.getState().banner).toBeNull();
    });

    it('T13 a diff read started before a refresh (for the row as the old status described it) does not land after it: the refresh reads the selected row again', async () => {
      const before = deferred<ReturnType<typeof diffOf>>();
      const fetchDiff = vi.fn().mockReturnValueOnce(before.promise).mockResolvedValue(diffOf('after refresh'));
      const store = createGitStore({ fetchDiff, load: async () => ({ repoRoot: '/repo', changes: [row('a.ts')] }) });
      store.setState({ repoRoot: '/repo', changes: [row('a.ts')] });

      store.getState().selectFile('a.ts', 'staged');
      await store.getState().refresh();
      await store.getState().loadDiff('a.ts', 'staged');
      expect(shownA(store)).toBe('after refresh');
      before.resolve(diffOf('before refresh'));
      await before.promise;
      await Promise.resolve();
      expect(shownA(store)).toBe('after refresh');
      expect(fetchDiff).toHaveBeenCalledTimes(2);
    });

    it('T15 clear() also retires what is in flight: a refresh or a diff read that finishes afterwards changes nothing', async () => {
      const loaded = deferred<Loaded>();
      const diff = deferred<ReturnType<typeof diffOf>>();
      const store = createGitStore({ load: () => loaded.promise, fetchDiff: () => diff.promise });
      store.setState({ repoRoot: '/repo', changes: [row('a.ts')] });
      store.getState().selectFile('a.ts', 'staged');
      const refreshing = store.getState().refresh();
      store.getState().clear();

      loaded.resolve({ repoRoot: '/repo', changes: [row('a.ts')] });
      diff.resolve(diffOf('late'));
      await refreshing;
      await diff.promise;
      await Promise.resolve();
      expect(store.getState()).toMatchObject({ repoRoot: null, changes: [], selected: null, isLoading: false });
      expect(store.getState().diffCache.size).toBe(0);
    });

    it('T14 asking for the diff that is already being read joins that read instead of starting a second one (selectFile and the panel effect both ask), and every caller can await it', async () => {
      const pending = deferred<ReturnType<typeof diffOf>>();
      const fetchDiff = vi.fn().mockReturnValue(pending.promise);
      const store = createGitStore({ fetchDiff });
      store.setState({ repoRoot: '/repo', changes: [row('a.ts')] });

      store.getState().selectFile('a.ts', 'staged');
      const second = store.getState().loadDiff('a.ts', 'staged');
      const third = store.getState().loadDiff('a.ts', 'staged');
      expect(fetchDiff).toHaveBeenCalledTimes(1);
      pending.resolve(diffOf('once'));
      await Promise.all([second, third]);
      expect(shownA(store)).toBe('once');
      // 读完之后再要:缓存命中
      await store.getState().loadDiff('a.ts', 'staged');
      expect(fetchDiff).toHaveBeenCalledTimes(1);
    });
  });
});
