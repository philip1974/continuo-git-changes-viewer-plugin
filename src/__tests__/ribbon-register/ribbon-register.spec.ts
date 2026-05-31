// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type {
  CoPluginApp,
  CommandSpec,
  PanelSpec,
  PluginManifest,
  RibbonActionSpec,
} from '../../sdk/types';

interface TestNode {
  readonly type: unknown;
  readonly props: unknown;
  readonly children: readonly unknown[];
}

class TestPluginBase {
  readonly app: CoPluginApp;
  readonly manifest: PluginManifest;

  constructor(app: CoPluginApp, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }

  onload(): void {}
}

function makeNode(type: unknown, props?: unknown, ...children: unknown[]): TestNode {
  return { type, props, children };
}

function installCo() {
  globalThis.co = {
    Plugin: TestPluginBase,
    React: {
      createElement: vi.fn(
        (type: unknown, props?: unknown, ...children: unknown[]): ReactNode =>
          makeNode(type, props, ...children) as unknown as ReactNode,
      ),
    },
    PermissionError: class PermissionError extends Error {},
    z: {},
  };
}

function makeApp(dock: CoPluginApp['dock'] | null = { openPanel: vi.fn() }) {
  const panels: PanelSpec[] = [];
  const commands: CommandSpec[] = [];
  const ribbons: RibbonActionSpec[] = [];
  const app = {
    version: '0.2.4',
    panels: {
      register: vi.fn((spec: PanelSpec) => {
        panels.push(spec);
        return { dispose: vi.fn() };
      }),
    },
    commands: {
      register: vi.fn((spec: CommandSpec) => {
        commands.push(spec);
        return { dispose: vi.fn() };
      }),
      getAll: vi.fn(() => commands),
      execute: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
    ribbon: {
      register: vi.fn((spec: RibbonActionSpec) => {
        ribbons.push(spec);
        return { dispose: vi.fn() };
      }),
    },
    dataStore: { read: vi.fn(), write: vi.fn() },
    settingTabs: { register: vi.fn() },
    workspace: { getRoot: vi.fn() },
    shell: { exec: vi.fn(), execStream: vi.fn() },
    fs: { requestScope: vi.fn() },
    network: {},
    clipboard: {},
    permission: {},
    ...(dock === null ? {} : { dock }),
    notifications: { show: vi.fn() },
  } as unknown as CoPluginApp;
  return { app, panels, commands, ribbons };
}

async function loadPluginClass() {
  installCo();
  const module = await import('../../main');
  return module.default;
}

afterEach(() => {
  vi.resetModules();
  globalThis.co = undefined;
  document.head.innerHTML = '';
});

describe('Git Changes ribbon registration', () => {
  it('T1 registers one ribbon action with inline SVG icon when dock SDK exists', async () => {
    const PluginClass = await loadPluginClass();
    const { app, ribbons } = makeApp();
    const plugin = new PluginClass(app, { id: 'git-changes-viewer' });

    await plugin.onload();

    expect(app.ribbon.register).toHaveBeenCalledTimes(1);
    expect(ribbons[0]).toMatchObject({
      id: 'git-changes-viewer-open',
      title: 'Git Changes',
      priority: 100,
    });
    expect(ribbons[0]?.onClick).toEqual(expect.any(Function));
  });

  it('T2 clicking the ribbon opens the Git Changes Viewer panel', async () => {
    const PluginClass = await loadPluginClass();
    const dock = { openPanel: vi.fn() };
    const { app, ribbons } = makeApp(dock);
    const plugin = new PluginClass(app, { id: 'git-changes-viewer' });

    await plugin.onload();
    await ribbons[0]?.onClick();

    expect(dock.openPanel).toHaveBeenCalledWith('git-changes-viewer');
  });

  it('T3 does not register the ribbon when dock.openPanel is unavailable', async () => {
    const PluginClass = await loadPluginClass();
    const { app } = makeApp(null);
    const plugin = new PluginClass(app, { id: 'git-changes-viewer' });

    await plugin.onload();

    expect(app.ribbon.register).not.toHaveBeenCalled();
  });

  it('T11 uses a lightweight inline SVG icon shape', async () => {
    const PluginClass = await loadPluginClass();
    const { app, ribbons } = makeApp();
    const plugin = new PluginClass(app, { id: 'git-changes-viewer' });

    await plugin.onload();

    const icon = ribbons[0]?.icon as TestNode | undefined;
    expect(icon?.type).toBe('svg');
    expect(icon?.children).toHaveLength(4);
    expect(icon?.children.map((child) => (child as TestNode).type)).toEqual([
      'circle',
      'circle',
      'path',
      'path',
    ]);
  });
});
