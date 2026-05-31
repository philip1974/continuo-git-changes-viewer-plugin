// @vitest-environment jsdom
// v0.1.2 hotfix: main.ts onload 注入 CSS 需 document → jsdom env
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CoPluginApp,
  CommandSpec,
  PanelSpec,
  PluginManifest,
  RibbonActionSpec,
} from '../../sdk/types';

class TestPluginBase {
  readonly app: CoPluginApp;
  readonly manifest: PluginManifest;

  constructor(app: CoPluginApp, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }

  onload(): void {}
}

function makeApp() {
  const panels: PanelSpec[] = [];
  const commands: CommandSpec[] = [];
  const ribbons: RibbonActionSpec[] = [];

  const app = {
    version: '0.2.2',
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
    dataStore: {
      read: vi.fn(),
      write: vi.fn(),
    },
    settingTabs: {
      register: vi.fn(),
    },
    workspace: {
      getRoot: vi.fn(),
    },
    shell: {
      exec: vi.fn(),
      execStream: vi.fn(),
    },
    fs: {},
    network: {},
    clipboard: {},
    permission: {},
  } as unknown as CoPluginApp;

  return { app, panels, commands, ribbons };
}

async function loadPluginClass() {
  globalThis.co = {
    Plugin: TestPluginBase,
    React: {
      createElement: vi.fn(() => null),
    },
    PermissionError: class PermissionError extends Error {},
    z: {},
  };
  const module = await import('../../main');
  return module.default;
}

afterEach(() => {
  vi.resetModules();
  globalThis.co = undefined;
});

describe('GitChangesViewerPlugin main lifecycle', () => {
  it('T1 onload registers panel and refresh command without ribbon', async () => {
    const PluginClass = await loadPluginClass();
    const { app, panels, commands } = makeApp();
    const plugin = new PluginClass(app, { id: 'git-changes-viewer' });

    await plugin.onload();

    expect(app.panels.register).toHaveBeenCalledTimes(1);
    expect(panels[0]?.type).toBe('git-changes-viewer');
    expect(panels[0]?.title).toBe('Git Changes Viewer');

    expect(app.commands.register).toHaveBeenCalledTimes(1);
    expect(commands.map((command) => command.id)).toEqual(['git-viewer.refresh']);
    expect(commands[0]?.fn).toEqual(expect.any(Function));

    expect(app.ribbon.register).not.toHaveBeenCalled();
  });

  it('T2 onunload disposes registered resources', async () => {
    const PluginClass = await loadPluginClass();
    const { app } = makeApp();
    const plugin = new PluginClass(app, { id: 'git-changes-viewer' });

    await plugin.onload();
    await plugin.onunload();

    const panelDisposable = vi.mocked(app.panels.register).mock.results[0]?.value;
    const commandDisposable = vi.mocked(app.commands.register).mock.results[0]?.value;
    expect(panelDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(commandDisposable.dispose).toHaveBeenCalledTimes(1);
  });
});
