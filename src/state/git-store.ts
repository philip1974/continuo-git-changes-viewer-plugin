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

export interface GitStoreDeps {
  readonly load?: () => Promise<GitStoreLoadResult>;
}

export interface GitViewerState {
  repoRoot: string | null;
  changes: FileChange[];
  selectedPath: string | null;
  diffCache: Map<string, string>;
  isLoading: boolean;
  banner: BannerState | null;
  refresh(): Promise<void>;
  selectFile(path: string): void;
  clear(): void;
  setBanner(banner: BannerState): void;
  dismissBanner(): void;
}

const emptyState = {
  repoRoot: null,
  changes: [],
  selectedPath: null,
  diffCache: new Map<string, string>(),
  isLoading: false,
  banner: null,
} satisfies Pick<
  GitViewerState,
  'repoRoot' | 'changes' | 'selectedPath' | 'diffCache' | 'isLoading' | 'banner'
>;

export function createGitStore(deps: GitStoreDeps = {}): StoreApi<GitViewerState> {
  return createStore<GitViewerState>((set) => ({
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
          isLoading: false,
        });
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
