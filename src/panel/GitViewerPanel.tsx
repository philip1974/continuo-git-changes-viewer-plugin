import { useEffect, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DiffResult } from '../git/diff-fetcher';
import { readStatusHash } from '../git/status-hash';
import { readAutoRefreshIntervalSec } from '../lib/settings-store';
import type { CoPluginApp, PanelApi } from '../sdk/types';
import type { AutoRefreshTimer, AutoRefreshTimerOpts } from '../state/auto-refresh-timer';
import type { GitViewerState } from '../state/git-store';
import { FileList } from './FileList';
import { DiffView } from './DiffView';

type AutoRefreshTimerController = Pick<AutoRefreshTimer, 'start' | 'stop'>;

interface GitViewerPanelProps {
  readonly app?: CoPluginApp;
  readonly store: StoreApi<GitViewerState>;
  readonly diff?: DiffResult | null;
  readonly scopeReady?: Promise<'grant' | 'deny' | 'no-workspace' | 'error'>;
  readonly panelApi?: PanelApi;
  readonly timer?: AutoRefreshTimerController;
  readonly pluginId?: string;
}

export function GitViewerPanel({
  app,
  store,
  diff: diffOverride = null,
  scopeReady,
  panelApi,
  timer,
  pluginId,
}: GitViewerPanelProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );

  // v0.1.1 hotfix: panel mount 时 auto-refresh 一次。auto-watch（fs/git hooks/轮询）
  // 仍是 v0.2 议题，不在 mount-time 装监听。
  useEffect(() => {
    void store.getState().refresh();
  }, [store]);

  useEffect(() => {
    if (!app || !panelApi || !timer || !pluginId) return;

    let cancelled = false;
    let lastHash = '';

    const start = async () => {
      const intervalSec = await readAutoRefreshIntervalSec(app.dataStore, pluginId);
      if (cancelled) return;
      if (intervalSec === 0) {
        timer.stop();
        return;
      }

      const repoRoot = store.getState().repoRoot;
      if (repoRoot) {
        try {
          lastHash = await readStatusHash(app, repoRoot);
        } catch {
          lastHash = '';
        }
      }
      if (cancelled || !panelApi.isVisible) return;

      const opts: AutoRefreshTimerOpts = {
        intervalMs: intervalSec * 1000,
        onTick: async () => {
          const currentRoot = store.getState().repoRoot;
          if (!currentRoot) return;
          const nextHash = await readStatusHash(app, currentRoot);
          if (nextHash === lastHash) return;
          lastHash = nextHash;
          await store.getState().refresh();
        },
        onError: (err) => {
          console.warn('[git-viewer] auto-refresh:', err);
        },
      };
      timer.start(opts);
    };

    const disposable = panelApi.onDidVisibilityChange((event) => {
      if (event.isVisible) {
        void start();
      } else {
        timer.stop();
      }
    });

    if (panelApi.isVisible) {
      void start();
    }

    return () => {
      cancelled = true;
      disposable.dispose();
    };
  }, [app, panelApi, pluginId, store, timer]);

  // v0.1.2 hotfix: 选中变化时确保 diff 被 fetch（refresh 时已 prefetch 首个；这里覆盖手动切换）
  useEffect(() => {
    if (state.selectedPath) {
      void store.getState().loadDiff(state.selectedPath);
    }
  }, [store, state.selectedPath]);

  const selected =
    state.changes.find((change) => change.path === state.selectedPath) ??
    state.changes[0] ??
    null;

  // v0.1.2 hotfix: 从 store.diffCache 读真实 diff；props.diff override 给 spec 用
  const diff: DiffResult | null =
    diffOverride ??
    (selected ? state.diffCache.get(selected.path) ?? null : null);

  return (
    <section className="cgv-panel">
      <header className="cgv-header">
        <span className="cgv-title">Git Changes</span>
        <button
          type="button"
          className="cgv-refresh-btn"
          onClick={() => void store.getState().refresh()}
          disabled={state.isLoading}
          title="Re-scan working tree (manual; auto-watch is v0.2)"
        >
          {state.isLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>
      <div className="cgv-body">
        <FileList store={store} changes={state.changes} />
        <DiffView
          app={app}
          scopeReady={scopeReady}
          store={store}
          change={selected}
          diff={diff}
        />
      </div>
      {state.banner ? (
        <div className={`cgv-banner cgv-banner--${state.banner.kind}`}>
          <span>{state.banner.message}</span>
          {state.banner.dismissable ? (
            <button type="button" onClick={() => store.getState().dismissBanner()}>
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
