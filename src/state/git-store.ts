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
  refresh(): Promise<void>;
  selectFile(path: string, mode: DiffMode): void;
  loadDiff(path: string, mode: DiffMode): Promise<void>;
  clear(): void;
  setBanner(banner: BannerState): void;
  dismissBanner(): void;
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

export function firstSelectableEntry(
  changes: readonly FileChange[],
): SelectedRef | null {
  const changed = selectChanged({ changes })[0];
  if (changed) return { path: changed.path, mode: 'changed' };
  const staged = selectStaged({ changes })[0];
  if (staged) return { path: staged.path, mode: 'staged' };
  const untracked = selectUntracked({ changes })[0];
  if (untracked) return { path: untracked.path, mode: 'changed' };
  return null;
}

function isModeValid(change: FileChange, mode: DiffMode): boolean {
  if (mode === 'staged') {
    return change.statusX !== ' ' && change.statusX !== '?';
  }
  return (
    (change.statusY !== ' ' && change.statusY !== '?') ||
    change.statusX === '?' ||
    change.statusY === '?'
  );
}

function reconcileSelected(
  previous: SelectedRef | null,
  changes: readonly FileChange[],
): SelectedRef | null {
  if (!previous) return firstSelectableEntry(changes);
  const samePath = changes.find((change) => change.path === previous.path);
  if (!samePath) return firstSelectableEntry(changes);
  if (isModeValid(samePath, previous.mode)) return previous;
  if (isModeValid(samePath, 'changed')) {
    return { path: previous.path, mode: 'changed' };
  }
  if (isModeValid(samePath, 'staged')) {
    return { path: previous.path, mode: 'staged' };
  }
  return firstSelectableEntry(changes);
}

const emptyState = {
  repoRoot: null,
  changes: [],
  selected: null,
  diffCache: new Map<string, DiffResult>(),
  isLoading: false,
  banner: null,
} satisfies Pick<
  GitViewerState,
  'repoRoot' | 'changes' | 'selected' | 'diffCache' | 'isLoading' | 'banner'
>;

export function createGitStore(deps: GitStoreDeps = {}): StoreApi<GitViewerState> {
  return createStore<GitViewerState>((set, get) => ({
    ...emptyState,
    async refresh() {
      set({ isLoading: true });
      try {
        const loaded = deps.load
          ? await deps.load()
          : { repoRoot: null, changes: [] };

        // v0.3.0 fix (post-GUI verify): preserve user selection + diffCache
        // across polling refresh. Previously every tick wiped diffCache and
        // reset selectedPath via firstSelectablePath → entire panel
        // re-rendered (DiffView re-mounted, file selection jumped, 3-section
        // UI flicker). Now only invalidate the diff for files whose presence
        // changed; keep selection if the file is still tracked.
        const prev = get();
        const nextSelected = reconcileSelected(prev.selected, loaded.changes);

        // Keep cached diffs for files still in the list; invalidate the
        // currently selected file (its content may have changed — that's
        // why the polling tick fired).
        const nextDiffCache = new Map<string, DiffResult>();
        const presentPaths = new Set(loaded.changes.map((c) => c.path));
        const currentKey = nextSelected
          ? cacheKey(nextSelected.path, nextSelected.mode)
          : null;
        for (const [path, diff] of prev.diffCache) {
          if (presentPaths.has(diff.path) && path !== currentKey) {
            nextDiffCache.set(path, diff);
          }
        }

        set({
          repoRoot: loaded.repoRoot,
          changes: loaded.changes,
          selected: nextSelected,
          diffCache: nextDiffCache,
          isLoading: false,
        });
        if (nextSelected) void get().loadDiff(nextSelected.path, nextSelected.mode);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.onError?.('error', message);
        set({
          isLoading: false,
          banner: deps.onError
            ? null
            : {
                kind: 'error',
                message,
                dismissable: true,
              },
        });
      }
    },
    selectFile(path, mode) {
      set({ selected: { path, mode } });
      void get().loadDiff(path, mode);
    },
    async loadDiff(path, mode) {
      const { repoRoot, changes, diffCache } = get();
      if (!repoRoot || !deps.fetchDiff) return;
      const key = cacheKey(path, mode);
      if (diffCache.has(key)) return; // cache hit
      const change = changes.find((c) => c.path === path);
      if (!change) return;
      try {
        const result = await deps.fetchDiff(repoRoot, change, mode);
        const next = new Map(get().diffCache);
        next.set(key, result);
        set({ diffCache: next });
      } catch (err) {
        set({
          banner: {
            kind: 'error',
            message: `Failed to load diff for ${path}: ${err instanceof Error ? err.message : String(err)}`,
            dismissable: true,
          },
        });
      }
    },
    clear() {
      set({
        repoRoot: null,
        changes: [],
        selected: null,
        diffCache: new Map(),
        isLoading: false,
        banner: null,
      });
    },
    setBanner(banner) {
      set({ banner });
    },
    dismissBanner() {
      set({ banner: null });
    },
  }));
}
