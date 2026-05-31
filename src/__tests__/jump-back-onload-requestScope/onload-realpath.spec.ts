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

describe('requestScope onload realpath canonicalization', () => {
  it('T1 requests scope for the canonical workspace root', async () => {
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
      workspace: { getRoot: vi.fn(async () => '/Users/me/repo-link') },
      fs: {
        realpath: vi.fn(async () => '/private/var/repo'),
        requestScope: vi.fn(async () => 'grant'),
      },
      shell: { exec: vi.fn(), execStream: vi.fn() },
    } as unknown as CoPluginApp;
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await plugin.scopeReady;

    expect(app.fs.requestScope).toHaveBeenCalledWith([
      { path: '/private/var/repo', mode: 'r' },
    ]);
  });
});

