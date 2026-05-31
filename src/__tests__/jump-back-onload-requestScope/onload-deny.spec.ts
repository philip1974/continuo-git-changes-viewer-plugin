// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoPluginApp, PluginManifest } from '../../sdk/types';

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

afterEach(() => {
  vi.resetModules();
  globalThis.co = undefined;
  document.head.innerHTML = '';
});

describe('requestScope onload deny', () => {
  it('T1 shows a disabled toast when user denies scope', async () => {
    installCo();
    const PluginClass = (await import('../../main')).default;
    const notifications = { show: vi.fn() };
    const app = {
      panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      ribbon: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      workspace: { getRoot: vi.fn(async () => '/repo') },
      fs: {
        realpath: vi.fn(async () => '/repo'),
        requestScope: vi.fn(async () => 'deny'),
      },
      shell: { exec: vi.fn(), execStream: vi.fn() },
      dock: { openPanel: vi.fn() },
      notifications,
    } as unknown as CoPluginApp;
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('deny');

    expect(notifications.show).toHaveBeenCalledWith({
      kind: 'warning',
      message: 'fs scope denied; jump-back disabled',
    });
    expect(plugin.store.getState().banner).toBeNull();
  });

  it('T1b falls back to a disabled banner when notifications are unavailable', async () => {
    installCo();
    const PluginClass = (await import('../../main')).default;
    const app = {
      panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      ribbon: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      workspace: { getRoot: vi.fn(async () => '/repo') },
      fs: {
        realpath: vi.fn(async () => '/repo'),
        requestScope: vi.fn(async () => 'deny'),
      },
      shell: { exec: vi.fn(), execStream: vi.fn() },
      dock: { openPanel: vi.fn() },
    } as unknown as CoPluginApp;
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('deny');

    expect(plugin.store.getState().banner).toEqual({
      kind: 'warn',
      message: 'fs scope denied; jump-back disabled',
      dismissable: true,
    });
  });
});
