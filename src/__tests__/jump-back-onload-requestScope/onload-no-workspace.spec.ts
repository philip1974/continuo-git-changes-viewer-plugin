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
  it('T1 sets a workspace banner and does not request scope', async () => {
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
      workspace: { getRoot: vi.fn(async () => null) },
      fs: { realpath: vi.fn(), requestScope: vi.fn() },
      shell: { exec: vi.fn(), execStream: vi.fn() },
    } as unknown as CoPluginApp;
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('no-workspace');

    expect(app.fs.requestScope).not.toHaveBeenCalled();
    expect(plugin.store.getState().banner?.message).toContain(
      'Open a workspace folder',
    );
  });
});

