// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitStore } from '../../state/git-store';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import type { CoPluginApp, PluginManifest } from '../../sdk/types';

const detectRepoMock = vi.hoisted(() => vi.fn());
const scanStatusMock = vi.hoisted(() => vi.fn());

vi.mock('../../git/repo-detect', () => ({ detectRepo: detectRepoMock }));
vi.mock('../../git/status-scanner', async (orig) => ({
  ...(await orig<typeof import('../../git/status-scanner')>()),
  scanStatus: scanStatusMock,
}));

class TestPluginBase {
  readonly app: CoPluginApp;
  readonly manifest: PluginManifest;
  constructor(app: CoPluginApp, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }
  onload(): void {}
}

function makeApp(probeStdout: string) {
  const exec = vi.fn(async (_cmd: string, _args: readonly string[], _opts?: unknown) => ({
    stdout: probeStdout,
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
  }));
  const app = {
    panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    ribbon: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    workspace: { getRoot: vi.fn(async () => '/repo') },
    fs: { requestScope: vi.fn(async () => 'grant') },
    shell: { exec, execStream: vi.fn() },
    notifications: { show: vi.fn() },
  } as unknown as CoPluginApp;
  return { app, exec };
}

async function loadPlugin(app: CoPluginApp) {
  globalThis.co = {
    Plugin: TestPluginBase,
    React: { createElement: vi.fn(() => null) },
    PermissionError: class PermissionError extends Error {},
    z: {},
  };
  const PluginClass = (await import('../../main')).default;
  const plugin = new PluginClass(app, { id: 'git-viewer' } as PluginManifest);
  await plugin.onload();
  return plugin;
}

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.clearAllMocks();
  globalThis.co = undefined;
  document.head.innerHTML = '';
});

describe('restricted repository', () => {
  it('B1 refresh on a repo whose local config has executable keys runs no git besides the probe', async () => {
    const { app, exec } = makeApp('local\0filter.x.clean\nevil\0');
    const plugin = await loadPlugin(app);

    await plugin.store.getState().refresh();

    const state = plugin.store.getState();
    expect(state.repoRoot).toBeNull();
    expect(state.changes).toEqual([]);
    expect(state.restriction).toContain('filter.x.clean');
    expect(detectRepoMock).not.toHaveBeenCalled();
    expect(scanStatusMock).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![1]).toContain('--show-scope');
  });

  it('B2 every refresh re-probes, so a cleaned-up config is picked up and the restriction clears', async () => {
    const { app, exec } = makeApp('local\0filter.x.clean\nevil\0');
    detectRepoMock.mockResolvedValue({ ok: true, root: '/repo' });
    scanStatusMock.mockResolvedValue([]);
    const plugin = await loadPlugin(app);

    await plugin.store.getState().refresh();
    expect(plugin.store.getState().restriction).not.toBeNull();

    exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false });
    await plugin.store.getState().refresh();

    expect(exec).toHaveBeenCalledTimes(2);
    expect(plugin.store.getState().restriction).toBeNull();
    expect(plugin.store.getState().repoRoot).toBe('/repo');
    expect(scanStatusMock).toHaveBeenCalledTimes(1);
  });

  it('B4 onload installs the guard on app.shell: any helper calling gitExec on a restricted repo is refused', async () => {
    const { app, exec } = makeApp('local\0diff.external\nevil\0');
    const plugin = await loadPlugin(app);
    const { gitExec } = await import('../../git/exec');

    const r = await gitExec(app, '/repo', ['status', '--porcelain=v1', '-z']);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('diff.external');
    expect(exec.mock.calls.every((call) => call[1].includes('--show-scope'))).toBe(true);
    await plugin.onunload();
  });

  it('B3 the panel shows the restriction as a non-dismissable alert', async () => {
    const store = createGitStore({
      load: async () => ({ repoRoot: null, changes: [], restriction: 'Git commands are disabled for this repository' }),
    });

    render(<GitViewerPanel store={store} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Git commands are disabled for this repository');
    expect(alert.querySelector('button')).toBeNull();
  });
});
