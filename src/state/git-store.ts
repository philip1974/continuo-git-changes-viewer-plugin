import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DiffMode, DiffResult } from '../git/diff-fetcher';
import type { FileChange } from '../git/status-scanner';
import type { BannerKind } from '../lib/notification-mapping';

export type { DiffMode } from '../git/diff-fetcher';

export interface BannerState {
  readonly kind: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly dismissable: boolean;
}

export interface GitStoreLoadResult {
  readonly repoRoot: string | null;
  readonly changes: FileChange[];
  /** 受限仓库(本地 config 含可执行项)时的提示;此时 repoRoot 为 null,不运行任何 git。 */
  readonly restriction?: string | null;
  /**
   * `git status` 没有给出完整、可信的列表(失败 / 超时 / 输出被截断)时的原因。面板显示它,并禁用
   * Commit / Amend——否则会提交面板里看不到的暂存内容。
   */
  readonly statusError?: string | null;
}

export interface SelectedRef {
  readonly path: string;
  readonly mode: DiffMode;
}

export interface GitStoreDeps {
  readonly load?: () => Promise<GitStoreLoadResult>;
  readonly fetchDiff?: (
    repoRoot: string,
    change: FileChange,
    mode: DiffMode,
  ) => Promise<DiffResult>;
  readonly onError?: (kind: BannerKind, message: string) => void;
}

export interface GitViewerState {
  repoRoot: string | null;
  changes: FileChange[];
  selected: SelectedRef | null;
  diffCache: Map<string, DiffResult>;
  isLoading: boolean;
  banner: BannerState | null;
  commitMessage: string;
  amend: boolean;
  restriction: string | null;
  /** 最近一次 refresh 没拿到可信的 status(原因);下一次成功的 refresh 清除。非 null 时禁用 Commit / Amend。 */
  statusError: string | null;
  refresh(): Promise<void>;
  selectFile(path: string, mode: DiffMode): void;
  loadDiff(path: string, mode: DiffMode): Promise<void>;
  clear(): void;
  setBanner(banner: BannerState): void;
  dismissBanner(): void;
  setCommitMessage(message: string): void;
  setAmend(value: boolean): void;
}

interface ChangeSlice {
  readonly changes: readonly FileChange[];
}

export function selectStaged(state: ChangeSlice): FileChange[] {
  return state.changes.filter(
    (change) => change.statusX !== ' ' && change.statusX !== '?',
  );
}

export function selectChanged(state: ChangeSlice): FileChange[] {
  return state.changes.filter(
    (change) => change.statusY !== ' ' && change.statusY !== '?',
  );
}

export function selectUntracked(state: ChangeSlice): FileChange[] {
  return state.changes.filter(
    (change) => change.statusX === '?' || change.statusY === '?',
  );
}

export function cacheKey(path: string, mode: DiffMode): string {
  return `${mode}:${path}`;
}

// 不可操作行(FileChange.inoperable)不可选中:选中即读 diff,而插件不为这些路径运行任何命令。
export function firstSelectableEntry(
  all: readonly FileChange[],
): SelectedRef | null {
  const changes = all.filter((change) => !change.inoperable);
  const changed = selectChanged({ changes })[0];
  if (changed) return { path: changed.path, mode: 'changed' };
  const staged = selectStaged({ changes })[0];
  if (staged) return { path: staged.path, mode: 'staged' };
  const untracked = selectUntracked({ changes })[0];
  if (untracked) return { path: untracked.path, mode: 'changed' };
  return null;
}

/** 这条记录是否出现在 mode 对应的区里(staged → Staged 区;changed → Changes / Untracked 区)。 */
function listedIn(change: FileChange, mode: DiffMode): boolean {
  if (mode === 'staged') {
    return change.statusX !== ' ' && change.statusX !== '?';
  }
  return (
    (change.statusY !== ' ' && change.statusY !== '?') ||
    change.statusX === '?' ||
    change.statusY === '?'
  );
}

function isModeValid(change: FileChange, mode: DiffMode): boolean {
  return !change.inoperable && listedIn(change, mode);
}

/**
 * 一行对应的 status 记录。行的身份是 (path, 区),不是 path:`git rm --cached f` 之后 status 对同一路径给出
 * 两条记录——`D  f`(Staged 区)与 `?? f`(Untracked 区,mode 'changed')。只按 path 找会永远拿到第一条:
 * 点未跟踪那一行却取了"已暂存删除"的 diff(显示 no textual diff),刷新后选中还会跳到 Staged 区。
 * 该区里没有这个路径的记录 → undefined(那一行不存在)。
 */
export function findChange(
  changes: readonly FileChange[],
  path: string,
  mode: DiffMode,
): FileChange | undefined {
  return changes.find((change) => change.path === path && listedIn(change, mode));
}

function reconcileSelected(
  previous: SelectedRef | null,
  changes: readonly FileChange[],
): SelectedRef | null {
  if (!previous) return firstSelectableEntry(changes);
  const samePath = changes.filter((change) => change.path === previous.path);
  const valid = (mode: DiffMode) => samePath.some((change) => isModeValid(change, mode));
  if (valid(previous.mode)) return previous;
  if (valid('changed')) return { path: previous.path, mode: 'changed' };
  if (valid('staged')) return { path: previous.path, mode: 'staged' };
  return firstSelectableEntry(changes);
}

const emptyState = {
  repoRoot: null,
  changes: [],
  selected: null,
  diffCache: new Map<string, DiffResult>(),
  isLoading: false,
  banner: null,
  commitMessage: '',
  amend: false,
  restriction: null,
  statusError: null,
} satisfies Pick<
  GitViewerState,
  | 'repoRoot'
  | 'changes'
  | 'selected'
  | 'diffCache'
  | 'isLoading'
  | 'banner'
  | 'commitMessage'
  | 'amend'
  | 'restriction'
  | 'statusError'
>;

export function createGitStore(deps: GitStoreDeps = {}): StoreApi<GitViewerState> {
  // 手动 Refresh、文件操作之后的 refresh、自动刷新的 tick(含 status 出错后的重试)可以同时在途。
  // 只让最近一次发起的 refresh 落盘:慢的旧 refresh 晚到时,既不能用旧列表盖掉新的,也不能把新的那次报告的
  // statusError 清掉(那会在旧列表上放开 Commit)。
  let refreshSeq = 0;
  // 在途的 diff 读取,按缓存键。同一键再次请求时并入在途的那次;selectFile / refresh / clear 把在途的作废
  // (从表里拿掉)——作废的读取晚到时不写缓存、不报错:它读的是更早的状态。
  const loading = new Map<string, { promise: Promise<void> }>();

  return createStore<GitViewerState>((set, get) => ({
    ...emptyState,
    async refresh() {
      const seq = ++refreshSeq;
      set({ isLoading: true });
      try {
        const loaded = deps.load
          ? await deps.load()
          : { repoRoot: null, changes: [] };
        if (seq !== refreshSeq) return;

        // 选择跨 refresh 保留(v0.3.0:每个 tick 重置选择会让整个面板跳动);diff 缓存不保留。
        // 缓存里的 diff 是上一次 status 时读的:已暂存的文件再次修改并 `git add`(XY 仍是 `M `)之后,
        // 留着非选中文件的缓存,点回去显示的是旧版本,而 Commit 提交的是新版本。refresh 之后只有当前
        // 选中的那份会被重新读取(下面的 loadDiff),其余的等用户点到时再读(selectFile 总是重读)。
        const prev = get();
        const nextSelected = reconcileSelected(prev.selected, loaded.changes);
        const nextDiffCache = new Map<string, DiffResult>();
        loading.clear();

        set({
          repoRoot: loaded.repoRoot,
          changes: loaded.changes,
          selected: nextSelected,
          diffCache: nextDiffCache,
          isLoading: false,
          restriction: loaded.restriction ?? null,
          statusError: loaded.statusError ?? null,
        });
        if (nextSelected) void get().loadDiff(nextSelected.path, nextSelected.mode);
      } catch (err) {
        if (seq !== refreshSeq) return;
        const message = err instanceof Error ? err.message : String(err);
        deps.onError?.('error', message);
        // refresh 本身失败:当前状态未知(列表是上一次的)。statusError 让面板持续显示原因并禁用
        // Commit / Amend,直到下一次 refresh 成功;不再另设可关闭的 banner(同一条信息)。
        set({ isLoading: false, statusError: message });
      }
    },
    selectFile(path, mode) {
      if (findChange(get().changes, path, mode)?.inoperable) return;
      // 点击总是重读:缓存的那份可能早于最近一次外部改动(两次自动刷新之间,或 status 指纹覆盖不到的
      // 未选中工作树文件)。显示的内容不早于这次点击。
      const diffCache = new Map(get().diffCache);
      diffCache.delete(cacheKey(path, mode));
      loading.delete(cacheKey(path, mode));
      set({ selected: { path, mode }, diffCache });
      void get().loadDiff(path, mode);
    },
    loadDiff(path, mode) {
      const { repoRoot, changes, diffCache } = get();
      const fetchDiff = deps.fetchDiff;
      if (!repoRoot || !fetchDiff) return Promise.resolve();
      const key = cacheKey(path, mode);
      if (diffCache.has(key)) return Promise.resolve(); // cache hit
      const pending = loading.get(key);
      if (pending) return pending.promise;
      const change = findChange(changes, path, mode);
      if (!change || change.inoperable) return Promise.resolve();

      const entry = { promise: Promise.resolve() };
      const current = () => loading.get(key) === entry;
      loading.set(key, entry);
      entry.promise = (async () => {
        try {
          const result = await fetchDiff(repoRoot, change, mode);
          if (!current()) return;
          const next = new Map(get().diffCache);
          next.set(key, result);
          set({ diffCache: next });
        } catch (err) {
          if (!current()) return;
          set({
            banner: {
              kind: 'error',
              message: `Failed to load diff for ${path}: ${err instanceof Error ? err.message : String(err)}`,
              dismissable: true,
            },
          });
        } finally {
          if (current()) loading.delete(key);
        }
      })();
      return entry.promise;
    },
    clear() {
      refreshSeq += 1;
      loading.clear();
      set({
        repoRoot: null,
        changes: [],
        selected: null,
        diffCache: new Map(),
        isLoading: false,
        banner: null,
        commitMessage: '',
        amend: false,
        restriction: null,
        statusError: null,
      });
    },
    setBanner(banner) {
      set({ banner });
    },
    dismissBanner() {
      set({ banner: null });
    },
    setCommitMessage(message) {
      set({ commitMessage: message });
    },
    setAmend(value) {
      set({ amend: value });
    },
  }));
}
