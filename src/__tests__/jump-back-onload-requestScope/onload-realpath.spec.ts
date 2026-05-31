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

describe('requestScope onload (v0.1.6: no realpath canonicalize)', () => {
  it('T1 requests scope for raw workspace root (skip realpath — chicken-and-egg)', async () => {
    globalThis.co = {
      Plugin: TestPluginBase,
      React: { createElement: vi.fn(() => null) },
      PermissionError: class PermissionError extends Error {},
      z: {},
    };
    const PluginClass = (await import('../../main')).default;
    const realpath = vi.fn(async () => '/private/var/repo');
    const app = {
      panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      workspace: { getRoot: vi.fn(async () => '/Users/me/repo-link') },
      fs: {
        realpath,
        requestScope: vi.fn(async () => 'grant'),
      },
      shell: { exec: vi.fn(), execStream: vi.fn() },
    } as unknown as CoPluginApp;
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await plugin.scopeReady;

    // v0.1.6 hot-fix: realpath enforce scope itself → must not call before requestScope.
    // Skip canonicalize entirely; symlink edge case deferred.
    expect(realpath).not.toHaveBeenCalled();
    expect(app.fs.requestScope).toHaveBeenCalledWith([
      { path: '/Users/me/repo-link', mode: 'r' },
    ]);
  });
});

