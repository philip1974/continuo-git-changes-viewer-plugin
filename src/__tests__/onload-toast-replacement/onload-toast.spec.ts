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

function installCo(
  PermissionError: new (permission: string, message?: string) => Error = class PermissionError extends Error {},
) {
  globalThis.co = {
    Plugin: TestPluginBase,
    React: { createElement: vi.fn(() => null) },
    PermissionError,
    z: {},
  };
}

function makeApp(opts: {
  readonly root: string | null;
  readonly requestScope: () => Promise<'grant' | 'deny'>;
  readonly notifications?: { show: ReturnType<typeof vi.fn> };
}): CoPluginApp {
  return {
    panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    ribbon: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    workspace: { getRoot: vi.fn(async () => opts.root) },
    fs: {
      realpath: vi.fn(),
      requestScope: vi.fn(opts.requestScope),
    },
    shell: { exec: vi.fn(), execStream: vi.fn() },
    dock: { openPanel: vi.fn() },
    ...(opts.notifications ? { notifications: opts.notifications } : {}),
  } as unknown as CoPluginApp;
}

async function loadPluginClass() {
  const module = await import('../../main');
  return module.default;
}

afterEach(() => {
  vi.resetModules();
  globalThis.co = undefined;
  document.head.innerHTML = '';
});

describe('requestScope onload toast replacement', () => {
  it('T4a shows a warning toast when no workspace is open', async () => {
    installCo();
    const PluginClass = await loadPluginClass();
    const notifications = { show: vi.fn() };
    const plugin = new PluginClass(
      makeApp({ root: null, requestScope: async () => 'grant', notifications }),
      { id: 'git-viewer' },
    );

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('no-workspace');

    expect(notifications.show).toHaveBeenCalledWith({
      kind: 'warning',
      message: 'Open a workspace folder to enable jump-back',
    });
    expect(plugin.store.getState().banner).toBeNull();
  });

  it('T4b shows a warning toast when fs scope is denied', async () => {
    installCo();
    const PluginClass = await loadPluginClass();
    const notifications = { show: vi.fn() };
    const plugin = new PluginClass(
      makeApp({ root: '/repo', requestScope: async () => 'deny', notifications }),
      { id: 'git-viewer' },
    );

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('deny');

    expect(notifications.show).toHaveBeenCalledWith({
      kind: 'warning',
      message: 'fs scope denied; jump-back disabled',
    });
    expect(plugin.store.getState().banner).toBeNull();
  });

  it('T4c shows an error toast when requestScope throws PermissionError', async () => {
    class PermissionError extends Error {}
    installCo(PermissionError as never);
    const PluginClass = await loadPluginClass();
    const notifications = { show: vi.fn() };
    const plugin = new PluginClass(
      makeApp({
        root: '/repo',
        requestScope: async () => {
          throw new PermissionError('fs');
        },
        notifications,
      }),
      { id: 'git-viewer' },
    );

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('error');

    expect(notifications.show).toHaveBeenCalledWith({
      kind: 'error',
      message: "Please grant 'fs' permission via Plugin Manager",
      code: 'PERMISSION_DENIED',
    });
    expect(plugin.store.getState().banner).toBeNull();
  });

  it('T5a falls back to an inline banner when notifications are unavailable', async () => {
    installCo();
    const PluginClass = await loadPluginClass();
    const plugin = new PluginClass(
      makeApp({ root: '/repo', requestScope: async () => 'deny' }),
      { id: 'git-viewer' },
    );

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('deny');

    expect(plugin.store.getState().banner).toEqual({
      kind: 'warn',
      message: 'fs scope denied; jump-back disabled',
      dismissable: true,
    });
  });
});
