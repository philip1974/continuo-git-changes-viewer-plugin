import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { discardFile } from '../git/discard-file';
import { discardHunk } from '../git/discard-hunk';
import { isWorktreeDiffStale, type DiffResult } from '../git/diff-fetcher';
import { readStatusHash } from '../git/status-hash';
import { stageFile } from '../git/stage-file';
import { stageHunk } from '../git/stage-hunk';
import { unstageFile } from '../git/unstage-file';
import { unstageHunk } from '../git/unstage-hunk';
import type { SettingsBus } from '../lib/settings-bus';
import { visibleText } from '../lib/visible-text';
import {
  type AutoRefreshIntervalSec,
  readAutoRefreshIntervalSec,
} from '../lib/settings-store';
import type { CoPluginApp, PanelApi } from '../sdk/types';
import type { AutoRefreshTimer, AutoRefreshTimerOpts } from '../state/auto-refresh-timer';
import { RetryBackoff } from '../state/retry-backoff';
import { cacheKey, findChange, selectStaged, type GitViewerState } from '../state/git-store';
import { COMMIT_IN_PROGRESS_MESSAGE, COMMIT_IN_PROGRESS_TITLE, FileList } from './FileList';
import { DiffView } from './DiffView';
import { CommitEditor } from './CommitEditor';
import {
  PreviewDrawer,
  previewDrawerReducer,
  type DrawerAction,
  type PreviewDrawerState,
} from './PreviewDrawer';
import { isUnmerged, type FileChange } from '../git/status-scanner';
import type { SectionKind } from '../git/can-stage-hunk';

export const DIFF_REFRESHING_NOTE = 'Refreshing diff…';

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

      // 面板(重新)可见:立即比较一次,不等下一个 tick。面板隐藏期间 timer 是停的——此前这里把"上次的指纹"
      // 直接覆盖成当前值,隐藏期间的变化(终端里重新 `git add`)于是永远不会触发刷新:面板显示旧内容,
      // Commit 提交新内容。
      try {
        await refreshIfChanged();
      } catch (err) {
        console.warn('[git-viewer] auto-refresh:', err);
      }
      if (cancelled || !panelApi.isVisible) return;

      const retry = new RetryBackoff(intervalSec * 1000);
      const opts: AutoRefreshTimerOpts = {
        intervalMs: intervalSec * 1000,
        onTick: async () => {
          // v0.2.2: window-level visibility gate via live property read
          // (NOT event subscription — Electron macOS does not reliably fire
          // visibilitychange/focus on Cmd+M Dock restore). document.visibilityState
          // is an always-fresh property; reading it each tick guarantees we resume
          // exactly when the window comes back, no events needed.
          if (document.visibilityState !== 'visible') return;

          // 上一次 refresh 没拿到可信的 status(statusError):不能再靠"指纹变了才刷新"——一次瞬时失败之后
          // status 输出往往没变,错误提示和被禁用的 Commit / Amend 会一直留到用户手动 Refresh。此时每个 tick
          // 都重新完整刷新,直到成功;持续失败时按退避放慢(不在每个 tick 空转一次完整刷新)。
          if (store.getState().statusError !== null) {
            if (!retry.due()) return;
            await store.getState().refresh();
            if (store.getState().statusError !== null) retry.failed();
            else retry.reset();
            return;
          }
          retry.reset();
          // 见下面的 refreshIfChanged(readStatusHash 与 store 里的指纹比较)
          await refreshIfChanged();
        },
        onError: (err) => {
          console.warn('[git-viewer] auto-refresh:', err);
        },
      };
      timer.start(opts);
    };

    // "仓库变了就刷新"的唯一实现——tick、面板重新可见、窗口重新可见都走这里。基线只有一份:store 里
    // 与当前列表同一次读取的指纹(statusFingerprint,由 load 在读 status 之前读出)。没有组件自己的"上次指纹"。
    // 两项比较,任一变了就刷新:
    // - status 指纹(porcelain v2:含 HEAD / index 的对象 id,覆盖一切已暂存内容的变化);
    // - 当前显示的是工作树 diff 时,文件的标记与读取那份 diff 时是否相同(status 不含工作树内容:
    //   同一个未暂存文件再次被编辑,XY 不变)。
    async function refreshIfChanged(): Promise<void> {
      if (!app) return;
      const before = store.getState();
      // statusError:由 tick 的重试(带退避)处理。isLoading:在途的那次 refresh 会带来新的指纹与列表——
      // 首次挂载时正是这种情况(挂载即 refresh),此时再比较只会多刷一次。
      if (before.statusError !== null || before.isLoading) return;
      const currentRoot = before.repoRoot;
      if (!currentRoot) return;
      let nextHash: string;
      try {
        nextHash = await readStatusHash(app, currentRoot);
      } catch {
        // 指纹读不到(status 失败 / 超时):与"status 不可用"同样对待,不另起一套——完整刷新一次,load 会把
        // 原因放进 statusError(面板显示、Commit / Amend 禁用);此后的 tick 走上面 statusError 的退避重试。
        // 此前这里直接抛出:每个 tick 一条 console 警告,面板上什么都看不出来。
        if (!cancelled) await store.getState().refresh();
        return;
      }
      if (cancelled) return;
      const { statusFingerprint, selected: shown, diffCache, diffRefreshingKey } = store.getState();
      if (nextHash === statusFingerprint) {
        // 显示的是旧结果、新的正在读(diffRefreshingKey):它的标记当然是旧的——不为此再 refresh。
        // 那会作废在途的读取;读取慢于刷新间隔时,新结果永远到不了。
        if (diffRefreshingKey !== null) return;
        // Staged 区的 diff 不读工作树、不带标记:isWorktreeDiffStale 对它直接是 false
        const shownDiff = shown ? diffCache.get(cacheKey(shown.path, shown.mode)) : undefined;
        if (!(await isWorktreeDiffStale(app, currentRoot, shownDiff))) return;
      }
      await store.getState().refresh();
    }

    const disposable = panelApi.onDidVisibilityChange((event) => {
      if (event.isVisible) {
        void start();
      } else {
        timer.stop();
      }
    });

    // 窗口重新可见:同样立即比较一次。只是"更快";这个事件在 Electron macOS 上不可靠(见 onTick 的说明),
    // 没触发时由下一个 tick 的同一比较兜底。
    const onWindowVisibility = () => {
      if (document.visibilityState !== 'visible' || !panelApi.isVisible || intervalSec === 0) return;
      void refreshIfChanged().catch((err: unknown) => {
        console.warn('[git-viewer] auto-refresh:', err);
      });
    };
    document.addEventListener('visibilitychange', onWindowVisibility);

    if (panelApi.isVisible) {
      void start();
    }

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onWindowVisibility);
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
      ? findChange(state.changes, selectedRef.path, selectedRef.mode) ?? null
      : null;

  // v0.1.2 hotfix: 从 store.diffCache 读真实 diff；props.diff override 给 spec 用
  const diff: DiffResult | null =
    diffOverride ??
    (selectedRef
      ? state.diffCache.get(cacheKey(selectedRef.path, selectedRef.mode)) ?? null
      : null);
  const stagedCount = selectStaged({ changes: state.changes }).length;

  const showError = (message: string) => {
    if (typeof app?.notifications?.show === 'function') {
      app.notifications.show({ kind: 'error', message: visibleText(message) });
      return;
    }
    store.getState().setBanner({ kind: 'error', message, dismissable: true });
  };

  const showInfo = (message: string) => {
    if (typeof app?.notifications?.show === 'function') {
      app.notifications.show({ kind: 'info', message: visibleText(message) });
      return;
    }
    store.getState().setBanner({ kind: 'info', message, dismissable: true });
  };

  const runFileAction = async (
    change: FileChange,
    action: Extract<DrawerAction, 'stage' | 'unstage'>,
  ) => {
    const { repoRoot, commitInFlight } = store.getState();
    if (!app || !repoRoot) {
      showError(!repoRoot ? 'Repo root unknown' : 'SDK shell unavailable');
      return;
    }
    // 提交在进行:按钮本是禁用的(这是点击与重新渲染之间的兜底)。此时改暂存区会让提交的内容不确定。
    if (commitInFlight) {
      showError(COMMIT_IN_PROGRESS_MESSAGE);
      return;
    }

    // 从点击(同步,在任何 await 之前)到 git 命令与随后的 refresh 结束,Commit / Amend 不可用(见 CommitEditor)
    const endWrite = store.getState().beginWrite();
    try {
      const result = action === 'stage'
        ? await stageFile(app, repoRoot, change.path, { untracked: change.statusX === '?' })
        : await unstageFile(app, repoRoot, change.path);
      if (!mountedRef.current) return;

      if (!result.ok) {
        showError(result.error || 'File operation failed; refresh');
        return;
      }

      await store.getState().refresh();
      if (!mountedRef.current) return;
      // 未合并的行(UD / DD)上 Stage 就是 `git add`:冲突被标记为已解决——照实说
      showInfo(
        action === 'stage' && isUnmerged(change)
          ? `Marked ${change.path} as resolved (staged)`
          : `${action === 'stage' ? 'Staged' : 'Unstaged'} ${change.path}`,
      );
    } catch (err) {
      // 宿主拒绝执行(并发 exec 超限等)会以 rejection 到这里:照常报告,不留未处理的 rejection
      if (mountedRef.current) showError(err instanceof Error ? err.message : String(err));
    } finally {
      endWrite();
    }
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
    const { repoRoot, commitInFlight } = store.getState();
    if (!app || !repoRoot || commitInFlight) {
      // 提交在进行:确认按钮本是禁用的(兜底,见 runFileAction)
      const message = !repoRoot ? 'Repo root unknown' : !app ? 'SDK shell unavailable' : COMMIT_IN_PROGRESS_MESSAGE;
      dispatchDrawer({ type: 'confirm' });
      if (!mountedRef.current) return;
      dispatchDrawer({ type: 'fail', error: message });
      showError(message);
      return;
    }

    dispatchDrawer({ type: 'confirm' });
    const endWrite = store.getState().beginWrite();
    try {
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
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      dispatchDrawer({ type: 'fail', error: message });
      showError(message);
    } finally {
      endWrite();
    }
  };

  return (
    <section className="cgv-panel">
      <header className="cgv-header">
        <span className="cgv-title">Git Changes</span>
        {/* 屏幕上的 diff 是刷新之前读的、新的还没到(git-store 的 diffRefreshingKey)。标记放在头部而不是 diff 区里:
            diff 区是滚动容器,往里加 / 减一行会让正在看的位置跳动。 */}
        {selectedRef !== null && state.diffRefreshingKey === cacheKey(selectedRef.path, selectedRef.mode) ? (
          <span className="cgv-header-note" role="status">
            {DIFF_REFRESHING_NOTE}
          </span>
        ) : null}
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
      <CommitEditor
        app={app}
        store={store}
        commitMessage={state.commitMessage}
        stagedCount={stagedCount}
        repoRoot={state.repoRoot}
        amend={state.amend}
        statusUnavailable={state.statusError !== null}
        fileOpInFlight={state.writesInFlight > 0}
        commitInFlight={state.commitInFlight}
      />
      <div className="cgv-body">
        <FileList
          store={store}
          changes={state.changes}
          onStageFile={(change) => void runFileAction(change, 'stage')}
          onUnstageFile={(change) => void runFileAction(change, 'unstage')}
          onDiscardFile={openDiscardFileDrawer}
          writesBlocked={state.commitInFlight}
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
          writesBlocked={state.commitInFlight}
        />
      </div>
      <PreviewDrawer
        state={drawer}
        onConfirm={handleDrawerConfirm}
        onCancel={() => dispatchDrawer({ type: 'cancel' })}
        confirmBlockedReason={state.commitInFlight ? COMMIT_IN_PROGRESS_TITLE : null}
      />
      {state.restriction ? (
        <div className="cgv-banner cgv-banner--warn cgv-restricted" role="alert">
          <span>{visibleText(state.restriction)}</span>
        </div>
      ) : state.statusError !== null ? (
        // 不可关闭:只有下一次成功的 refresh 才清除(与 restriction 同样的呈现方式)
        <div className="cgv-banner cgv-banner--error" role="alert">
          <span>{`Could not read the repository status: ${visibleText(state.statusError)}. Commit and Amend are disabled until a refresh succeeds.`}</span>
        </div>
      ) : state.banner ? (
        <div className={`cgv-banner cgv-banner--${state.banner.kind}`}>
          <span>{visibleText(state.banner.message)}</span>
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
