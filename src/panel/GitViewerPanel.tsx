import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DiffResult } from '../git/diff-fetcher';
import { readStatusHash } from '../git/status-hash';
import type { SettingsBus } from '../lib/settings-bus';
import {
  type AutoRefreshIntervalSec,
  readAutoRefreshIntervalSec,
} from '../lib/settings-store';
import type { CoPluginApp, PanelApi } from '../sdk/types';
import type { AutoRefreshTimer, AutoRefreshTimerOpts } from '../state/auto-refresh-timer';
import { cacheKey, type GitViewerState } from '../state/git-store';
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
  readonly settingsBus?: SettingsBus;
}

export function GitViewerPanel({
  app,
  store,
  diff: diffOverride = null,
  scopeReady,
  panelApi,
  timer,
  pluginId,
  settingsBus,
}: GitViewerPanelProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  const [intervalSec, setIntervalSec] =
    useState<AutoRefreshIntervalSec | null>(null);
  const lastHashRef = useRef('');

  // v0.1.1 hotfix: panel mount 时 auto-refresh 一次。auto-watch（fs/git hooks/轮询）
  // 仍是 v0.2 议题，不在 mount-time 装监听。
  useEffect(() => {
    void store.getState().refresh();
  }, [store]);

  useEffect(() => {
    if (!app || !pluginId) return;
    let cancelled = false;

    void readAutoRefreshIntervalSec(app.dataStore, pluginId).then((stored) => {
      if (!cancelled) setIntervalSec(stored);
    });

    return () => {
      cancelled = true;
    };
  }, [app, pluginId]);

  useEffect(() => {
    if (!settingsBus) return;
    const disposable = settingsBus.on(setIntervalSec);
    return () => disposable.dispose();
  }, [settingsBus]);

  useEffect(() => {
    if (!app || !panelApi || !timer || intervalSec === null) return;

    let cancelled = false;

    const start = async () => {
      if (cancelled) return;
      if (intervalSec === 0) {
        timer.stop();
        return;
      }
      if (!panelApi.isVisible) return;

      const repoRoot = store.getState().repoRoot;
      if (repoRoot) {
        try {
          lastHashRef.current = await readStatusHash(app, repoRoot);
        } catch {
          // Keep the previous hash across interval-only restarts.
        }
      }
      if (cancelled || !panelApi.isVisible) return;

      const opts: AutoRefreshTimerOpts = {
        intervalMs: intervalSec * 1000,
        onTick: async () => {
          // v0.2.2: window-level visibility gate via live property read
          // (NOT event subscription — Electron macOS does not reliably fire
          // visibilitychange/focus on Cmd+M Dock restore). document.visibilityState
          // is an always-fresh property; reading it each tick guarantees we resume
          // exactly when the window comes back, no events needed.
          if (document.visibilityState !== 'visible') return;

          const currentRoot = store.getState().repoRoot;
          if (!currentRoot) return;
          const nextHash = await readStatusHash(app, currentRoot);
          if (nextHash === lastHashRef.current) return;
          lastHashRef.current = nextHash;
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
      timer.stop();
    };
  }, [app, intervalSec, panelApi, store, timer]);

  // v0.1.2 hotfix: 选中变化时确保 diff 被 fetch（refresh 时已 prefetch 首个；这里覆盖手动切换）
  useEffect(() => {
    if (state.selected) {
      void store.getState().loadDiff(state.selected.path, state.selected.mode);
    }
  }, [store, state.selected]);

  const selectedRef = state.selected;
  const selected =
    selectedRef
      ? state.changes.find((change) => change.path === selectedRef.path) ?? null
      : null;

  // v0.1.2 hotfix: 从 store.diffCache 读真实 diff；props.diff override 给 spec 用
  const diff: DiffResult | null =
    diffOverride ??
    (selectedRef
      ? state.diffCache.get(cacheKey(selectedRef.path, selectedRef.mode)) ?? null
      : null);

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
          mode={selectedRef?.mode ?? 'changed'}
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
