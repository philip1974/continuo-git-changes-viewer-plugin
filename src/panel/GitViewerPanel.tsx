import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { discardFile } from '../git/discard-file';
import { discardHunk } from '../git/discard-hunk';
import type { DiffResult } from '../git/diff-fetcher';
import { readStatusHash } from '../git/status-hash';
import { stageFile } from '../git/stage-file';
import { stageHunk } from '../git/stage-hunk';
import { unstageFile } from '../git/unstage-file';
import { unstageHunk } from '../git/unstage-hunk';
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
import {
  PreviewDrawer,
  previewDrawerReducer,
  type DrawerAction,
  type PreviewDrawerState,
} from './PreviewDrawer';
import type { FileChange } from '../git/status-scanner';
import type { SectionKind } from '../git/can-stage-hunk';

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
  const mountedRef = useRef(true);
  const closeTimerRef = useRef<number | null>(null);
  const [drawer, dispatchDrawer] = useReducer(previewDrawerReducer, {
    kind: 'idle',
  } satisfies PreviewDrawerState);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

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

  const showError = (message: string) => {
    if (typeof app?.notifications?.show === 'function') {
      app.notifications.show({ kind: 'error', message });
      return;
    }
    store.getState().setBanner({ kind: 'error', message, dismissable: true });
  };

  const showInfo = (message: string) => {
    if (typeof app?.notifications?.show === 'function') {
      app.notifications.show({ kind: 'info', message });
      return;
    }
    store.getState().setBanner({ kind: 'info', message, dismissable: true });
  };

  const runFileAction = async (
    change: FileChange,
    action: Extract<DrawerAction, 'stage' | 'unstage'>,
  ) => {
    const repoRoot = store.getState().repoRoot;
    if (!app || !repoRoot) {
      showError(!repoRoot ? 'Repo root unknown' : 'SDK shell unavailable');
      return;
    }

    const result = action === 'stage'
      ? await stageFile(app, repoRoot, change.path)
      : await unstageFile(app, repoRoot, change.path);
    if (!mountedRef.current) return;

    if (!result.ok) {
      showError(result.error || 'File operation failed; refresh');
      return;
    }

    await store.getState().refresh();
    if (!mountedRef.current) return;
    showInfo(`${action === 'stage' ? 'Staged' : 'Unstaged'} ${change.path}`);
  };

  const openDiscardFileDrawer = (change: FileChange, _section: SectionKind) => {
    dispatchDrawer({
      type: 'open',
      action: 'discard-file',
      filePath: change.path,
      body: `File: ${change.path} (X=${change.statusX} Y=${change.statusY})`,
    });
  };

  const handleDrawerConfirm = async () => {
    if (drawer.kind !== 'previewing' && drawer.kind !== 'error') return;
    const repoRoot = store.getState().repoRoot;
    if (!app || !repoRoot) {
      const message = !repoRoot ? 'Repo root unknown' : 'SDK shell unavailable';
      dispatchDrawer({ type: 'confirm' });
      if (!mountedRef.current) return;
      dispatchDrawer({ type: 'fail', error: message });
      showError(message);
      return;
    }

    dispatchDrawer({ type: 'confirm' });
    const result =
      drawer.action === 'stage'
        ? drawer.patch
          ? await stageHunk(app, repoRoot, drawer.patch)
          : { ok: false, error: 'Patch unavailable' }
        : drawer.action === 'unstage'
          ? drawer.patch
            ? await unstageHunk(app, repoRoot, drawer.patch)
            : { ok: false, error: 'Patch unavailable' }
          : drawer.action === 'discard'
            ? drawer.patch
              ? await discardHunk(app, repoRoot, drawer.patch)
              : { ok: false, error: 'Patch unavailable' }
            : await discardFile(app, repoRoot, drawer.filePath);
    if (!mountedRef.current) return;

    if (!result.ok) {
      const message = result.error || 'File operation failed; refresh';
      dispatchDrawer({ type: 'fail', error: message });
      showError(message);
      return;
    }

    dispatchDrawer({ type: 'succeed' });
    if (drawer.action === 'discard') {
      showInfo(`Hunk discarded from ${drawer.filePath}`);
    } else if (drawer.action === 'discard-file') {
      showInfo(`Discarded ${drawer.filePath}`);
    }
    await store.getState().refresh();
    if (!mountedRef.current) return;
    closeTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) dispatchDrawer({ type: 'dismiss' });
    }, 800);
  };

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
        <FileList
          store={store}
          changes={state.changes}
          onStageFile={(change) => void runFileAction(change, 'stage')}
          onUnstageFile={(change) => void runFileAction(change, 'unstage')}
          onDiscardFile={openDiscardFileDrawer}
        />
        <DiffView
          app={app}
          scopeReady={scopeReady}
          store={store}
          change={selected}
          diff={diff}
          mode={selectedRef?.mode ?? 'changed'}
          drawer={drawer}
          dispatchDrawer={dispatchDrawer}
        />
      </div>
      <PreviewDrawer
        state={drawer}
        onConfirm={handleDrawerConfirm}
        onCancel={() => dispatchDrawer({ type: 'cancel' })}
      />
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
