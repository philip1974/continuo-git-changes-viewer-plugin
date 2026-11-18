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

const LAYOUT_OK = 'true\n\n/repo/.git\n/repo/.git\n/repo\n';
const isLayoutProbe = (args: readonly string[]) => args.includes('--is-inside-work-tree');

// probeStdout:配置探测(git config --list)的输出;layoutStdout:布局探测(git rev-parse)的输出;
// gitDirEntries:宿主 listDir 对 /repo/.git 返回的条目(符号链接检查)。
function makeApp(
  probeStdout: string,
  layoutStdout = LAYOUT_OK,
  gitDirEntries: ReadonlyArray<{ name: string; isSymlink: boolean }> = [],
) {
  const state = { probeStdout, layoutStdout, gitDirEntries };
  const exec = vi.fn(async (_cmd: string, args: readonly string[], _opts?: unknown) => ({
    stdout: isLayoutProbe(args) ? state.layoutStdout : state.probeStdout,
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
    fs: {
      requestScope: vi.fn(async () => 'grant'),
      listDir: vi.fn(async () =>
        state.gitDirEntries.map((e) => ({ ...e, isFile: !e.isSymlink, isDirectory: false })),
      ),
      lstat: vi.fn(async () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      }),
    },
    shell: { exec, execStream: vi.fn() },
    notifications: { show: vi.fn() },
  } as unknown as CoPluginApp;
  return { app, exec, state };
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
    const { app, exec, state } = makeApp('local\0filter.x.clean\nevil\0');
    detectRepoMock.mockResolvedValue({ ok: true, root: '/repo' });
    scanStatusMock.mockResolvedValue([]);
    const plugin = await loadPlugin(app);

    await plugin.store.getState().refresh();
    expect(plugin.store.getState().restriction).not.toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);

    state.probeStdout = '';
    await plugin.store.getState().refresh();

    // 第二次:配置探测 + 布局探测
    expect(exec).toHaveBeenCalledTimes(3);
    expect(plugin.store.getState().restriction).toBeNull();
    expect(plugin.store.getState().repoRoot).toBe('/repo');
    expect(scanStatusMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['config redirects the working tree', 'local\0core.worktree\n/etc\0', LAYOUT_OK, [], 'core.worktree'],
    ['git resolves the working tree elsewhere', '', 'false\n\n/repo/.git\n/repo/.git\n/etc\n', [], 'working tree'],
    ['git directory outside the workspace', '', 'true\n\n/victim/private/.git\n/victim/private/.git\n/repo\n', [], 'outside this folder (/victim/private/.git)'],
    ['symbolic link inside the git directory', '', LAYOUT_OK, [{ name: 'index', isSymlink: true }], 'symbolic link (index)'],
  ] as const)('B5 %s: refresh runs no git besides the probes and the store carries the reason', async (_label, config, layout, entries, text) => {
    const { app, exec } = makeApp(config, layout, entries);
    const plugin = await loadPlugin(app);

    await plugin.store.getState().refresh();

    const state = plugin.store.getState();
    expect(state.repoRoot).toBeNull();
    expect(state.restriction).toContain('Git commands are disabled for this repository');
    expect(state.restriction).toContain(text);
    expect(detectRepoMock).not.toHaveBeenCalled();
    expect(scanStatusMock).not.toHaveBeenCalled();
    expect(exec.mock.calls.every((c) => c[1].includes('--show-scope') || isLayoutProbe(c[1]))).toBe(true);
  });

  it('B6 refresh waits for the fs scope request before probing (the symlink check needs file access)', async () => {
    const { app, exec } = makeApp('');
    let grant!: (v: 'grant') => void;
    (app.fs.requestScope as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => (grant = r)));
    detectRepoMock.mockResolvedValue({ ok: true, root: '/repo' });
    scanStatusMock.mockResolvedValue([]);
    const plugin = await loadPlugin(app);

    const refreshing = plugin.store.getState().refresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(exec).not.toHaveBeenCalled();

    grant('grant');
    await refreshing;
    expect(plugin.store.getState().restriction).toBeNull();
    expect(plugin.store.getState().repoRoot).toBe('/repo');
  });

  it('B7 a forged index (status lists paths git never records): the repository becomes restricted — no file list, every later git call is refused — and a refresh after the index is repaired clears it', async () => {
    const { UnsafeIndexError } = await import('../../git/status-scanner');
    const { app, exec } = makeApp('');
    detectRepoMock.mockResolvedValue({ ok: true, root: '/repo' });
    scanStatusMock.mockRejectedValueOnce(new UnsafeIndexError(['../outside.txt', '.git/hooks/pre-commit']));
    const plugin = await loadPlugin(app);
    const { gitExec } = await import('../../git/exec');

    await plugin.store.getState().refresh();

    const state = plugin.store.getState();
    expect(state.repoRoot).toBeNull();
    expect(state.changes).toEqual([]);
    expect(state.restriction).toContain('Git commands are disabled for this repository');
    expect(state.restriction).toContain('../outside.txt, .git/hooks/pre-commit');
    expect(app.notifications?.show).not.toHaveBeenCalled();

    // 守卫也记住了:面板之外的入口(提交、自动刷新的 status hash ...)同样被拒,不起 git
    const spawned = exec.mock.calls.length;
    const refused = await gitExec(app, '/repo', ['commit', '-F', '-'], { input: 'x' });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('../outside.txt');
    expect(exec.mock.calls.length).toBe(spawned);

    scanStatusMock.mockResolvedValue([]);
    await plugin.store.getState().refresh();
    expect(plugin.store.getState().restriction).toBeNull();
    expect(plugin.store.getState().repoRoot).toBe('/repo');
    expect((await gitExec(app, '/repo', ['status'])).exitCode).toBe(0);
  });

  it('B7b any other failure of the status scan is not turned into a restriction', async () => {
    const { app } = makeApp('');
    detectRepoMock.mockResolvedValue({ ok: true, root: '/repo' });
    scanStatusMock.mockRejectedValueOnce(new Error('boom'));
    const plugin = await loadPlugin(app);
    await plugin.store.getState().refresh().catch(() => {});
    expect(plugin.store.getState().restriction).toBeNull();
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
