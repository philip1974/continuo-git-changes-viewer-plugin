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

function makeApp() {
  return {
    panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    workspace: { getRoot: vi.fn(async () => '/repo-link') },
    fs: {
      realpath: vi.fn(async () => '/repo'),
      requestScope: vi.fn(async () => 'grant'),
    },
    shell: { exec: vi.fn(), execStream: vi.fn() },
  } as unknown as CoPluginApp;
}

afterEach(() => {
  vi.resetModules();
  globalThis.co = undefined;
  document.head.innerHTML = '';
});

describe('requestScope onload grant', () => {
  it('T1 requests read scope on raw workspace root (v0.1.6 skip realpath)', async () => {
    installCo();
    const PluginClass = (await import('../../main')).default;
    const app = makeApp();
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('grant');

    // v0.1.6 hot-fix: realpath itself enforces scope → never call before grant.
    expect(app.fs.realpath).not.toHaveBeenCalled();
    expect(app.fs.requestScope).toHaveBeenCalledWith([
      { path: '/repo-link', mode: 'r' },
    ]);
  });
});

