// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitStore } from '../../state/git-store';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import type {
  CoPluginApp,
  Disposable,
  PanelApi,
  PanelVisibilityEvent,
} from '../../sdk/types';

const readStatusHashMock = vi.hoisted(() => vi.fn());
const readIntervalMock = vi.hoisted(() => vi.fn());

vi.mock('../../git/status-hash', () => ({
  readStatusHash: readStatusHashMock,
}));

vi.mock('../../lib/settings-store', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../lib/settings-store')>();
  return {
    ...original,
    readAutoRefreshIntervalSec: readIntervalMock,
  };
});

interface TimerStartOptions {
  readonly intervalMs: number;
  readonly onTick: () => Promise<void> | void;
  readonly onError?: (err: unknown) => void;
}

interface TestTimer {
  readonly start: ReturnType<typeof vi.fn<(opts: TimerStartOptions) => void>>;
  readonly stop: ReturnType<typeof vi.fn<() => void>>;
}

interface TestPanelApi extends PanelApi {
  emit(isVisible: boolean): void;
}

function makeApp(): CoPluginApp {
  return {
    dataStore: { read: vi.fn(), write: vi.fn() },
    shell: { exec: vi.fn(), execStream: vi.fn() },
  } as unknown as CoPluginApp;
}

function makeTimer(): TestTimer {
  return {
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function makePanelApi(initialVisible: boolean): TestPanelApi {
  const listeners: Array<(event: PanelVisibilityEvent) => void> = [];
  return {
    id: 'git-changes-viewer',
    isVisible: initialVisible,
    onDidVisibilityChange(cb: (event: PanelVisibilityEvent) => void): Disposable {
      listeners.push(cb);
      return {
        dispose: () => {
          const index = listeners.indexOf(cb);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
    },
    emit(isVisible: boolean): void {
      Object.defineProperty(this, 'isVisible', {
        configurable: true,
        value: isVisible,
      });
      for (const listener of [...listeners]) listener({ isVisible });
    },
  };
}

async function renderHarness({
  visible = true,
  repoRoot = '/repo',
}: {
  readonly visible?: boolean;
  readonly repoRoot?: string | null;
} = {}) {
  readIntervalMock.mockResolvedValue(5);
  readStatusHashMock.mockResolvedValue('initial');

  const app = makeApp();
  const store = createGitStore({
    load: async () => ({
      repoRoot,
      changes: repoRoot
        ? [{ path: 'src/a.ts', status: 'M' as const, statusX: ' ' as const, statusY: 'M' as const, kind: 'text' as const }]
        : [],
    }),
  });
  store.setState({ repoRoot });
  const timer = makeTimer();
  const panelApi = makePanelApi(visible);

  render(
    <GitViewerPanel
      app={app}
      store={store}
      panelApi={panelApi}
      timer={timer}
      pluginId="git-viewer"
    />,
  );
  await screen.findByText('Git Changes');
  if (visible) {
    await waitFor(() => expect(readIntervalMock).toHaveBeenCalled());
  }

  return { app, store, timer, panelApi };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GitViewerPanel auto-refresh wiring', () => {
  it('T9 starts polling when the panel is visible on mount', async () => {
    const { app, timer } = await renderHarness();

    await waitFor(() => expect(timer.start).toHaveBeenCalledTimes(1));
    expect(readIntervalMock).toHaveBeenCalledWith(app.dataStore, 'git-viewer');
    expect(timer.start).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 5000 }),
    );
  });

  it('T10 stops polling when dockview reports the panel hidden', async () => {
    const { panelApi, timer } = await renderHarness();

    panelApi.emit(false);

    expect(timer.stop).toHaveBeenCalledTimes(1);
  });

  it('T10b restarts polling when dockview reports the panel visible', async () => {
    const { panelApi, timer } = await renderHarness({ visible: false });

    expect(timer.start).not.toHaveBeenCalled();
    panelApi.emit(true);

    await waitFor(() => expect(timer.start).toHaveBeenCalledTimes(1));
  });

  it('T11 initializes last hash without forcing a second refresh', async () => {
    const { store } = await renderHarness();
    const refresh = vi.spyOn(store.getState(), 'refresh');

    await waitFor(() =>
      expect(readStatusHashMock).toHaveBeenCalledWith(expect.anything(), '/repo'),
    );

    expect(refresh).not.toHaveBeenCalled();
  });

  it('T12 skips refresh when the raw status hash is unchanged', async () => {
    const { store, timer } = await renderHarness();
    const refresh = vi.spyOn(store.getState(), 'refresh');
    readStatusHashMock.mockResolvedValue('initial');

    await waitFor(() => expect(timer.start).toHaveBeenCalled());
    const startOpts = timer.start.mock.calls[0]?.[0];
    await startOpts?.onTick();

    expect(refresh).not.toHaveBeenCalled();
  });

  it('T13 refreshes when the raw status hash changes', async () => {
    const { store, timer } = await renderHarness();
    const refresh = vi.spyOn(store.getState(), 'refresh').mockResolvedValue();
    readStatusHashMock.mockResolvedValue('changed');

    await waitFor(() => expect(timer.start).toHaveBeenCalled());
    const startOpts = timer.start.mock.calls[0]?.[0];
    await startOpts?.onTick();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  describe('a status error does not stick until a manual Refresh', () => {
    const setVisibility = (value: DocumentVisibilityState) =>
      Object.defineProperty(document, 'visibilityState', { configurable: true, value });
    afterEach(() => setVisibility('visible'));

    // load 的结果可切换:failing 时返回 statusError(与 main.ts 对 StatusUnavailableError 的处理一致)
    async function harnessWithStatus() {
      const h = await renderHarness();
      const state = { failing: true, loads: 0 };
      const refresh = vi.fn(async () => {
        state.loads += 1;
        h.store.setState({ statusError: state.failing ? 'git status failed (timed out)' : null });
      });
      h.store.setState({ refresh, statusError: 'git status failed (timed out)' });
      await waitFor(() => expect(h.timer.start).toHaveBeenCalled());
      const onTick = h.timer.start.mock.calls[0]![0].onTick;
      readStatusHashMock.mockClear();
      return { ...h, state, refresh, onTick };
    }

    it('T14 while statusError is set, a tick refreshes even though the status hash has not changed (the hash is not even read); once a refresh succeeds the hash comparison is back', async () => {
      const { state, refresh, onTick, store } = await harnessWithStatus();
      readStatusHashMock.mockResolvedValue('initial');

      state.failing = false;
      await onTick();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(readStatusHashMock).not.toHaveBeenCalled();
      expect(store.getState().statusError).toBeNull();

      // 恢复后:哈希没变就不刷新
      await onTick();
      await onTick();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(readStatusHashMock).toHaveBeenCalledTimes(2);
    });

    it('T15 while the refresh keeps failing the retries back off (1, 2, 4, 8 … ticks apart) up to about a minute, instead of a full refresh on every tick', async () => {
      const { refresh, onTick } = await harnessWithStatus();
      const ranAt: number[] = [];
      for (let tick = 1; tick <= 40; tick++) {
        const before = refresh.mock.calls.length;
        await onTick();
        if (refresh.mock.calls.length > before) ranAt.push(tick);
      }
      // 间隔 5 s:第 1 个 tick 立即重试,之后相隔 2、4、8 个 tick,再往后封顶 12 个 tick(60 s)
      expect(ranAt).toEqual([1, 3, 7, 15, 27, 39]);
      expect(readStatusHashMock).not.toHaveBeenCalled();
    });

    it('T16 a success resets the back-off: the next error is retried on the very next tick', async () => {
      const { state, refresh, onTick, store } = await harnessWithStatus();
      for (let tick = 1; tick <= 7; tick++) await onTick(); // 重试发生在 tick 1、3、7,都失败
      expect(refresh).toHaveBeenCalledTimes(3);
      state.failing = false;
      for (let tick = 8; tick <= 15; tick++) await onTick(); // tick 15 重试成功
      expect(refresh).toHaveBeenCalledTimes(4);
      expect(store.getState().statusError).toBeNull();

      state.failing = true;
      store.setState({ statusError: 'git status failed (exit 128)' });
      await onTick();
      expect(refresh).toHaveBeenCalledTimes(5);
      // ……且间隔从头算起:再失败后隔 2 个 tick 重试(没有重置的话要等 12 个)
      await onTick();
      expect(refresh).toHaveBeenCalledTimes(5);
      await onTick();
      expect(refresh).toHaveBeenCalledTimes(6);
    });

    it('T17 a hidden window does not retry (the visibility gate comes first), and a manual Refresh that succeeds in between also ends the retries', async () => {
      const { refresh, onTick, store } = await harnessWithStatus();
      setVisibility('hidden');
      await onTick();
      await onTick();
      expect(refresh).not.toHaveBeenCalled();
      setVisibility('visible');

      store.setState({ statusError: null }); // 手动 Refresh 成功
      readStatusHashMock.mockResolvedValue('initial');
      await onTick();
      expect(refresh).not.toHaveBeenCalled();
      expect(readStatusHashMock).toHaveBeenCalledTimes(1);
    });

    it('T18 an error with no repository root known yet (the very first load threw) is retried too', async () => {
      const { refresh, onTick, store } = await harnessWithStatus();
      store.setState({ repoRoot: null });
      await onTick();
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });
});
