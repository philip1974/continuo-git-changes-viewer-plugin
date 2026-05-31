import { useEffect, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DiffResult } from '../git/diff-fetcher';
import type { CoPluginApp } from '../sdk/types';
import type { GitViewerState } from '../state/git-store';
import { FileList } from './FileList';
import { DiffView } from './DiffView';

interface GitViewerPanelProps {
  readonly app?: CoPluginApp;
  readonly store: StoreApi<GitViewerState>;
  readonly diff?: DiffResult | null;
  readonly scopeReady?: Promise<'grant' | 'deny' | 'no-workspace' | 'error'>;
}

export function GitViewerPanel({
  app,
  store,
  diff: diffOverride = null,
  scopeReady,
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
