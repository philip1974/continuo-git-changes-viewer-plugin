import { createStore, type StoreApi } from 'zustand/vanilla';
import type { FileChange } from '../git/status-scanner';
import type { BannerKind } from '../lib/notification-mapping';

export interface BannerState {
  readonly kind: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly dismissable: boolean;
}

export interface GitStoreLoadResult {
  readonly repoRoot: string | null;
  readonly changes: FileChange[];
}

import type { DiffResult } from '../git/diff-fetcher';

export interface GitStoreDeps {
  readonly load?: () => Promise<GitStoreLoadResult>;
  readonly fetchDiff?: (
    repoRoot: string,
    change: FileChange,
  ) => Promise<DiffResult>;
  readonly onError?: (kind: BannerKind, message: string) => void;
}

export interface GitViewerState {
  repoRoot: string | null;
  changes: FileChange[];
  selectedPath: string | null;
  diffCache: Map<string, DiffResult>;
  isLoading: boolean;
  banner: BannerState | null;
  refresh(): Promise<void>;
  selectFile(path: string): void;
  loadDiff(path: string): Promise<void>;
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

function firstSelectablePath(changes: readonly FileChange[]): string | null {
  return (
    selectChanged({ changes })[0]?.path ??
    selectUntracked({ changes })[0]?.path ??
    null
  );
}

const emptyState = {
  repoRoot: null,
  changes: [],
  selectedPath: null,
  diffCache: new Map<string, DiffResult>(),
  isLoading: false,
  banner: null,
} satisfies Pick<
  GitViewerState,
  'repoRoot' | 'changes' | 'selectedPath' | 'diffCache' | 'isLoading' | 'banner'
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
        const stillPresent =
          prev.selectedPath !== null &&
          loaded.changes.some((c) => c.path === prev.selectedPath);
        const nextSelected = stillPresent
          ? prev.selectedPath
          : firstSelectablePath(loaded.changes);

        // Keep cached diffs for files still in the list; invalidate the
        // currently selected file (its content may have changed — that's
        // why the polling tick fired).
        const nextDiffCache = new Map<string, DiffResult>();
        const presentPaths = new Set(loaded.changes.map((c) => c.path));
        for (const [path, diff] of prev.diffCache) {
          if (presentPaths.has(path) && path !== nextSelected) {
            nextDiffCache.set(path, diff);
          }
        }

        set({
          repoRoot: loaded.repoRoot,
          changes: loaded.changes,
          selectedPath: nextSelected,
          diffCache: nextDiffCache,
          isLoading: false,
        });
        if (nextSelected) void get().loadDiff(nextSelected);
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
    selectFile(path) {
      set({ selectedPath: path });
      void get().loadDiff(path);
    },
    async loadDiff(path) {
      const { repoRoot, changes, diffCache } = get();
      if (!repoRoot || !deps.fetchDiff) return;
      if (diffCache.has(path)) return; // cache hit
      const change = changes.find((c) => c.path === path);
      if (!change) return;
      try {
        const result = await deps.fetchDiff(repoRoot, change);
        const next = new Map(get().diffCache);
        next.set(path, result);
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
        selectedPath: null,
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
