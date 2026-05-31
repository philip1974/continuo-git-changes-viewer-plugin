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
  it('T1 canonicalizes workspace root and requests read scope', async () => {
    installCo();
    const PluginClass = (await import('../../main')).default;
    const app = makeApp();
    const plugin = new PluginClass(app, { id: 'git-viewer' });

    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('grant');

    expect(app.fs.realpath).toHaveBeenCalledWith('/repo-link');
    expect(app.fs.requestScope).toHaveBeenCalledWith([
      { path: '/repo', mode: 'r' },
    ]);
  });
});

