// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsBus } from '../../lib/settings-bus';
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

function makeApp(): CoPluginApp {
  return {
    dataStore: { read: vi.fn(), write: vi.fn() },
    shell: { exec: vi.fn(), execStream: vi.fn() },
  } as unknown as CoPluginApp;
}

async function renderHarness({
  visible = true,
  interval = 5,
}: {
  readonly visible?: boolean;
  readonly interval?: 0 | 2 | 5 | 10;
} = {}) {
  readIntervalMock.mockResolvedValue(interval);
  readStatusHashMock.mockResolvedValue('initial');

  const app = makeApp();
  const store = createGitStore({
    load: async () => ({
      repoRoot: '/repo',
      changes: [{ path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }],
    }),
  });
  store.setState({ repoRoot: '/repo' });
  const panelApi = makePanelApi(visible);
  const timer: TestTimer = { start: vi.fn(), stop: vi.fn() };
  const settingsBus = new SettingsBus();

  render(
    <GitViewerPanel
      app={app}
      store={store}
      panelApi={panelApi}
      timer={timer}
      pluginId="git-viewer"
      settingsBus={settingsBus}
    />,
  );
  await screen.findByText('Git Changes');
  await waitFor(() => expect(readIntervalMock).toHaveBeenCalled());

  return { app, store, panelApi, timer, settingsBus };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GitViewerPanel live settings propagation', () => {
  it('T8 restarts the timer with a new visible interval', async () => {
    const { settingsBus, timer } = await renderHarness();

    await waitFor(() => expect(timer.start).toHaveBeenCalledTimes(1));
    settingsBus.emit(2);

    await waitFor(() =>
      expect(timer.start).toHaveBeenLastCalledWith(
        expect.objectContaining({ intervalMs: 2000 }),
      ),
    );
  });

  it('T9 stops polling when settings emit Off', async () => {
    const { settingsBus, timer } = await renderHarness();

    await waitFor(() => expect(timer.start).toHaveBeenCalledTimes(1));
    settingsBus.emit(0);

    await waitFor(() => expect(timer.stop).toHaveBeenCalled());
  });

  it('T10 stores a hidden interval change without starting polling', async () => {
    const { settingsBus, timer } = await renderHarness({ visible: false });

    expect(timer.start).not.toHaveBeenCalled();
    settingsBus.emit(2);

    await Promise.resolve();
    expect(timer.start).not.toHaveBeenCalled();
  });

  it('T11 starts with the latest interval after a hidden panel becomes visible', async () => {
    const { settingsBus, panelApi, timer } = await renderHarness({ visible: false });

    settingsBus.emit(2);
    panelApi.emit(true);

    await waitFor(() =>
      expect(timer.start).toHaveBeenCalledWith(
        expect.objectContaining({ intervalMs: 2000 }),
      ),
    );
  });

  it('T11.5 uses persisted settings at mount instead of a temporary default', async () => {
    const off = await renderHarness({ interval: 0 });

    await waitFor(() => expect(readIntervalMock).toHaveBeenCalled());
    expect(off.timer.start).not.toHaveBeenCalled();
    cleanup();
    vi.clearAllMocks();

    const ten = await renderHarness({ interval: 10 });

    await waitFor(() =>
      expect(ten.timer.start).toHaveBeenCalledWith(
        expect.objectContaining({ intervalMs: 10000 }),
      ),
    );
    expect(ten.timer.start).not.toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 5000 }),
    );
  });

  it('T12.5 skips refresh when interval changes but the status hash is equal', async () => {
    const { settingsBus, store, timer } = await renderHarness();
    const refresh = vi.spyOn(store.getState(), 'refresh');

    await waitFor(() => expect(timer.start).toHaveBeenCalledTimes(1));
    settingsBus.emit(2);
    await waitFor(() => expect(timer.start).toHaveBeenCalledTimes(2));
    const startOpts = timer.start.mock.calls[1]?.[0];
    readStatusHashMock.mockResolvedValue('initial');
    await startOpts?.onTick();

    expect(refresh).not.toHaveBeenCalled();
  });
});
