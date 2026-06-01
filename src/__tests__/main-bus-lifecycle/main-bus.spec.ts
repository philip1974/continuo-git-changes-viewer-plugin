// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CoPluginApp,
  CommandSpec,
  PanelApi,
  PanelSpec,
  PluginManifest,
  RibbonActionSpec,
  SettingTabSpec,
} from '../../sdk/types';

interface TestNode {
  readonly type: unknown;
  readonly props: Record<string, unknown> | null;
  readonly children: readonly unknown[];
}

const disposeMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/settings-bus', () => ({
  SettingsBus: vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    dispose: disposeMock,
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

function makeNode(
  type: unknown,
  props?: Record<string, unknown> | null,
  ...children: unknown[]
): TestNode {
  return { type, props: props ?? null, children };
}

function installCo() {
  globalThis.co = {
    Plugin: TestPluginBase,
    React: {
      createElement: vi.fn(
        (
          type: unknown,
          props?: Record<string, unknown> | null,
          ...children: unknown[]
        ) => makeNode(type, props, ...children) as unknown as React.ReactNode,
      ),
    },
    PermissionError: class PermissionError extends Error {},
    z: {},
  };
}

function makePanelApi(): PanelApi {
  return {
    id: 'git-changes-viewer',
    isVisible: true,
    onDidVisibilityChange: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function makeApp() {
  const panels: PanelSpec[] = [];
  const settingTabs: SettingTabSpec[] = [];
  const app = {
    panels: {
      register: vi.fn((spec: PanelSpec) => {
        panels.push(spec);
        return { dispose: vi.fn() };
      }),
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
        settingTabs.push(spec);
        return { dispose: vi.fn() };
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
  return { app, panels, settingTabs };
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

describe('GitChangesViewerPlugin settings bus lifecycle', () => {
  it('TLC1 passes the plugin settings bus to the panel factory', async () => {
    const PluginClass = await loadPluginClass();
    const { app, panels } = makeApp();
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    const node = panels[0]?.factory({ api: makePanelApi() }) as unknown as TestNode;

    expect(node.props?.settingsBus).toBeTruthy();
  });

  it('TLC2 passes the same settings bus to the settings tab render path', async () => {
    const PluginClass = await loadPluginClass();
    const { app, panels, settingTabs } = makeApp();
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    const panelNode = panels[0]?.factory({ api: makePanelApi() }) as unknown as TestNode;
    const settingsNode = settingTabs[0]?.render() as unknown as TestNode;

    expect(settingsNode.props?.bus).toBe(panelNode.props?.settingsBus);
  });

  it('TLC3 disposes the plugin settings bus on unload', async () => {
    const PluginClass = await loadPluginClass();
    const { app } = makeApp();
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await plugin.onunload();

    expect(disposeMock).toHaveBeenCalledTimes(1);
  });
});
