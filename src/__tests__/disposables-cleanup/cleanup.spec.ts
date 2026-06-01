// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CoPluginApp,
  CommandSpec,
  PanelSpec,
  PluginManifest,
  RibbonActionSpec,
  SettingTabSpec,
} from '../../sdk/types';

const stopMock = vi.hoisted(() => vi.fn());

vi.mock('../../state/auto-refresh-timer', () => ({
  AutoRefreshTimer: vi.fn(() => ({
    start: vi.fn(),
    stop: stopMock,
    isRunning: vi.fn(() => false),
  })),
}));

class TestPluginBase {
  readonly app: CoPluginApp;
  readonly manifest: PluginManifest;

  constructor(app: CoPluginApp, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }

  onload(): void {}
}

function installCo() {
  globalThis.co = {
    Plugin: TestPluginBase,
    React: { createElement: vi.fn(() => null) },
    PermissionError: class PermissionError extends Error {},
    z: {},
  };
}

function makeApp() {
  const settingTabDisposable = { dispose: vi.fn() };
  const specs: SettingTabSpec[] = [];
  const app = {
    panels: {
      register: vi.fn((_: PanelSpec) => ({ dispose: vi.fn() })),
    },
    commands: {
      register: vi.fn((_: CommandSpec) => ({ dispose: vi.fn() })),
      getAll: vi.fn(() => []),
      execute: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
    ribbon: {
      register: vi.fn((_: RibbonActionSpec) => ({ dispose: vi.fn() })),
    },
    settingTabs: {
      register: vi.fn((spec: SettingTabSpec) => {
        specs.push(spec);
        return settingTabDisposable;
      }),
    },
    dataStore: { read: vi.fn(), write: vi.fn() },
    workspace: { getRoot: vi.fn(async () => '/repo') },
    fs: { requestScope: vi.fn(async () => 'grant') },
    shell: { exec: vi.fn(), execStream: vi.fn() },
    network: {},
    clipboard: {},
    permission: {},
    dock: { openPanel: vi.fn() },
    notifications: { show: vi.fn() },
  } as unknown as CoPluginApp;
  return { app, specs, settingTabDisposable };
}

async function loadPluginClass() {
  installCo();
  const module = await import('../../main');
  return module.default;
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  globalThis.co = undefined;
  document.head.innerHTML = '';
});

describe('plugin disposable cleanup', () => {
  it('T17 stops the plugin-owned timer on unload', async () => {
    const PluginClass = await loadPluginClass();
    const { app } = makeApp();
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await plugin.onunload();

    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('T18 disposes the settings tab registration on unload', async () => {
    const PluginClass = await loadPluginClass();
    const { app, settingTabDisposable } = makeApp();
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await plugin.onunload();

    expect(app.settingTabs.register).toHaveBeenCalledTimes(1);
    expect(settingTabDisposable.dispose).toHaveBeenCalledTimes(1);
  });
});
