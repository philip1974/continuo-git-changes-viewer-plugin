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
  it('T1 sets a disabled banner when user denies scope', async () => {
    installCo();
    const PluginClass = (await import('../../main')).default;
    const app = {
      panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      workspace: { getRoot: vi.fn(async () => '/repo') },
      fs: {
        realpath: vi.fn(async () => '/repo'),
        requestScope: vi.fn(async () => 'deny'),
      },
      shell: { exec: vi.fn(), execStream: vi.fn() },
    } as unknown as CoPluginApp;
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('deny');

    expect(plugin.store.getState().banner?.message).toContain(
      'fs scope denied',
    );
  });
});

