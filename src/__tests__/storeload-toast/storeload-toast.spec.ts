// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoPluginApp, PluginManifest } from '../../sdk/types';

const detectRepoMock = vi.hoisted(() => vi.fn());
const scanStatusMock = vi.hoisted(() => vi.fn());

vi.mock('../../git/repo-detect', () => ({
  detectRepo: detectRepoMock,
}));

vi.mock('../../git/status-scanner', () => ({
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

function installCo() {
  globalThis.co = {
    Plugin: TestPluginBase,
    React: { createElement: vi.fn(() => null) },
    PermissionError: class PermissionError extends Error {},
    z: {},
  };
}

function makeApp(notifications?: { show: ReturnType<typeof vi.fn> }): CoPluginApp {
  return {
    panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    ribbon: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    workspace: { getRoot: vi.fn(async () => '/repo') },
    fs: {
      requestScope: vi.fn(async () => 'grant'),
      listDir: vi.fn(async () => []),
      lstat: vi.fn(async () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      }),
    },
    // 受限仓库探测:git config --list 返回空配置,布局探测(rev-parse)返回"workspace 根即工作树顶层、
    // git 目录在其内" = 可信仓库
    shell: {
      exec: vi.fn(async (_cmd: string, args: readonly string[]) => ({
        stdout: args.includes('--is-inside-work-tree') ? 'true\n\n/repo/.git\n/repo/.git\n/repo\n' : '',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
      })),
      execStream: vi.fn(),
    },
    dock: { openPanel: vi.fn() },
    ...(notifications ? { notifications } : {}),
  } as unknown as CoPluginApp;
}

async function loadPluginClass() {
  installCo();
  const module = await import('../../main');
  return module.default;
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  globalThis.co = undefined;
  document.head.innerHTML = '';
});

describe('store.load toast replacement', () => {
  it('T4d shows a warning toast when refresh detects an unsupported repo root', async () => {
    detectRepoMock.mockResolvedValue({
      ok: false,
      reason: 'not-git-root',
      root: '/repo/subdir',
    });
    const PluginClass = await loadPluginClass();
    const notifications = { show: vi.fn() };
    const plugin = new PluginClass(makeApp(notifications), { id: 'git-viewer' });

    await plugin.onload();
    await plugin.store.getState().refresh();

    expect(notifications.show).toHaveBeenCalledWith({
      kind: 'warning',
      message:
        'Git Changes Viewer v0.1 requires the workspace root to be the git toplevel.',
    });
    expect(plugin.store.getState().banner).toBeNull();
  });

  it('T5b falls back to an inline banner when notifications are unavailable', async () => {
    detectRepoMock.mockResolvedValue({
      ok: false,
      reason: 'no-workspace',
      root: null,
    });
    const PluginClass = await loadPluginClass();
    const plugin = new PluginClass(makeApp(), { id: 'git-viewer' });

    await plugin.onload();
    await plugin.store.getState().refresh();

    expect(plugin.store.getState().banner).toEqual({
      kind: 'warn',
      message: 'Open a workspace before refreshing Git changes.',
      dismissable: true,
    });
  });
});
