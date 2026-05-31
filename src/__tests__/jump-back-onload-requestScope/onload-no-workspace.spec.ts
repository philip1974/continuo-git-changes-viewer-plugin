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

describe('requestScope onload no workspace', () => {
  it('T1 shows a workspace toast and does not request scope', async () => {
    globalThis.co = {
      Plugin: TestPluginBase,
      React: { createElement: vi.fn(() => null) },
      PermissionError: class PermissionError extends Error {},
      z: {},
    };
    const PluginClass = (await import('../../main')).default;
    const app = {
      panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      ribbon: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      workspace: { getRoot: vi.fn(async () => null) },
      fs: { realpath: vi.fn(), requestScope: vi.fn() },
      shell: { exec: vi.fn(), execStream: vi.fn() },
      dock: { openPanel: vi.fn() },
      notifications: { show: vi.fn() },
    } as unknown as CoPluginApp;
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('no-workspace');

    expect(app.fs.requestScope).not.toHaveBeenCalled();
    expect(app.notifications?.show).toHaveBeenCalledWith({
      kind: 'warning',
      message: 'Open a workspace folder to enable jump-back',
    });
    expect(plugin.store.getState().banner).toBeNull();
  });

  it('T1b falls back to workspace banner when notifications are unavailable', async () => {
    globalThis.co = {
      Plugin: TestPluginBase,
      React: { createElement: vi.fn(() => null) },
      PermissionError: class PermissionError extends Error {},
      z: {},
    };
    const PluginClass = (await import('../../main')).default;
    const app = {
      panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      ribbon: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      workspace: { getRoot: vi.fn(async () => null) },
      fs: { realpath: vi.fn(), requestScope: vi.fn() },
      shell: { exec: vi.fn(), execStream: vi.fn() },
      dock: { openPanel: vi.fn() },
    } as unknown as CoPluginApp;
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('no-workspace');

    expect(app.fs.requestScope).not.toHaveBeenCalled();
    expect(plugin.store.getState().banner).toEqual({
      kind: 'warn',
      message: 'Open a workspace folder to enable jump-back',
      dismissable: true,
    });
  });
});
