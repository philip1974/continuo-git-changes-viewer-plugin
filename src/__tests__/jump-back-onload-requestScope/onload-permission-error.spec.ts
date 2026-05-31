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

afterEach(() => {
  vi.resetModules();
  globalThis.co = undefined;
  document.head.innerHTML = '';
});

describe('requestScope onload PermissionError', () => {
  it("T1 shows a toast asking the user to grant 'fs' when requestScope throws PermissionError", async () => {
    class PermissionError extends Error {}
    globalThis.co = {
      Plugin: TestPluginBase,
      React: { createElement: vi.fn(() => null) },
      PermissionError,
      z: {},
    };
    const PluginClass = (await import('../../main')).default;
    const notifications = { show: vi.fn() };
    const app = {
      panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      ribbon: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      workspace: { getRoot: vi.fn(async () => '/repo') },
      fs: {
        realpath: vi.fn(async () => '/repo'),
        requestScope: vi.fn(async () => {
          throw new PermissionError('fs');
        }),
      },
      shell: { exec: vi.fn(), execStream: vi.fn() },
      dock: { openPanel: vi.fn() },
      notifications,
    } as unknown as CoPluginApp;
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('error');

    expect(notifications.show).toHaveBeenCalledWith({
      kind: 'error',
      message: "Please grant 'fs' permission via Plugin Manager",
      code: 'PERMISSION_DENIED',
    });
    expect(plugin.store.getState().banner).toBeNull();
  });

  it("T1b falls back to a banner when notifications are unavailable", async () => {
    class PermissionError extends Error {}
    globalThis.co = {
      Plugin: TestPluginBase,
      React: { createElement: vi.fn(() => null) },
      PermissionError,
      z: {},
    };
    const PluginClass = (await import('../../main')).default;
    const app = {
      panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      ribbon: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      workspace: { getRoot: vi.fn(async () => '/repo') },
      fs: {
        realpath: vi.fn(async () => '/repo'),
        requestScope: vi.fn(async () => {
          throw new PermissionError('fs');
        }),
      },
      shell: { exec: vi.fn(), execStream: vi.fn() },
      dock: { openPanel: vi.fn() },
    } as unknown as CoPluginApp;
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('error');

    expect(plugin.store.getState().banner).toEqual({
      kind: 'error',
      message: "Please grant 'fs' permission via Plugin Manager",
      dismissable: true,
    });
  });
});
