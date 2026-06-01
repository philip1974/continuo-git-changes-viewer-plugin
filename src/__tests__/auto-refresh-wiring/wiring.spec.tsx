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
});
