import { createStore, type StoreApi } from 'zustand/vanilla';
import type { FileChange } from '../git/status-scanner';

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
        set({
          repoRoot: loaded.repoRoot,
          changes: loaded.changes,
          selectedPath: loaded.changes[0]?.path ?? null,
          diffCache: new Map<string, DiffResult>(),
          isLoading: false,
        });
        // v0.1.2 hotfix: refresh 完自动 prefetch 首个文件 diff
        const first = loaded.changes[0]?.path;
        if (first) void get().loadDiff(first);
      } catch (err) {
        set({
          isLoading: false,
          banner: {
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
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
