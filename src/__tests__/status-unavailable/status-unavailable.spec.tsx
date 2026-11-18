// @vitest-environment jsdom
// `git status` 失败 / 超时 / 输出被截断:列表不可信。此前静默显示成"没有改动",而 Amend 不看暂存数,
// 仍可点——提交的是用户在面板里看不到的暂存内容。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanStatus, StatusUnavailableError } from '../../git/status-scanner';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import type { CoPluginApp, PluginManifest, PluginShellExecResult } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';

const detectRepoMock = vi.hoisted(() => vi.fn());
vi.mock('../../git/repo-detect', () => ({ detectRepo: detectRepoMock }));

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.clearAllMocks();
  globalThis.co = undefined;
  document.head.innerHTML = '';
});

const res = (partial: Partial<PluginShellExecResult>): PluginShellExecResult => ({
  stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false, ...partial,
});
const isStatus = (args: readonly string[]) => args.includes('status');

function shellApp(status: Partial<PluginShellExecResult>) {
  const exec = vi.fn(async (_cmd: string, args: readonly string[]) => (isStatus(args) ? res(status) : res({})));
  return { app: { shell: { exec } } as unknown as CoPluginApp, exec };
}

const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as StatusUnavailableError);

describe('scanStatus reports an unusable status instead of an empty list', () => {
  it('S1 non-zero exit → StatusUnavailableError carrying the first line of stderr; numstat is not run', async () => {
    const { app, exec } = shellApp({ exitCode: 128, stderr: 'fatal: index file corrupt\nmore detail\n' });
    const err = await failure(scanStatus(app, '/repo'));
    expect(err).toBeInstanceOf(StatusUnavailableError);
    expect(err!.message).toBe('git status failed (fatal: index file corrupt)');
    expect(err!.partial).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('S2 timeout (no exit code) and a failure without stderr are named as such; an overlong stderr line is cut', async () => {
    expect((await failure(scanStatus(shellApp({ exitCode: null, signal: 'SIGTERM', timedOut: true }).app, '/repo')))!.message).toBe('git status failed (timed out)');
    expect((await failure(scanStatus(shellApp({ exitCode: 1 }).app, '/repo')))!.message).toBe('git status failed (exit 1)');
    expect((await failure(scanStatus(shellApp({ exitCode: null }).app, '/repo')))!.message).toBe('git status failed (exit unknown)');
    const long = await failure(scanStatus(shellApp({ exitCode: 1, stderr: 'x'.repeat(500) }).app, '/repo'));
    expect(long!.message).toBe(`git status failed (${'x'.repeat(200)}…)`);
  });

  it('S3 truncated output → StatusUnavailableError whose partial list holds the complete records (the cut-off tail is never an entry)', async () => {
    const { app } = shellApp({ stdout: 'M  a.txt\0?? b.txt\0 M very/long/pa', truncated: true });
    const err = await failure(scanStatus(app, '/repo'));
    expect(err).toBeInstanceOf(StatusUnavailableError);
    expect(err!.message).toBe('git status output was too large; the list of changes is incomplete');
    expect(err!.partial.map((c) => c.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('S4 a complete, successful status (even an empty one) resolves as before', async () => {
    await expect(scanStatus(shellApp({ stdout: '' }).app, '/repo')).resolves.toEqual([]);
    await expect(scanStatus(shellApp({ stdout: ' M a.txt\0' }).app, '/repo')).resolves.toHaveLength(1);
  });
});

describe('store: statusError', () => {
  it('S5 a load result with statusError sets it; the next clean load clears it', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ repoRoot: '/repo', changes: [], statusError: 'git status failed (exit 1)' })
      .mockResolvedValue({ repoRoot: '/repo', changes: [] });
    const store = createGitStore({ load });
    expect(store.getState().statusError).toBeNull();
    await store.getState().refresh();
    expect(store.getState().statusError).toBe('git status failed (exit 1)');
    await store.getState().refresh();
    expect(store.getState().statusError).toBeNull();
  });

  it('S6 a refresh that throws leaves the status unknown: statusError is set (the old list stays), and clears on the next success', async () => {
    const changes = [{ path: 'a.ts', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' }] as const;
    const load = vi
      .fn()
      .mockResolvedValueOnce({ repoRoot: '/repo', changes: [...changes] })
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockResolvedValue({ repoRoot: '/repo', changes: [...changes] });
    const onError = vi.fn();
    const store = createGitStore({ load, onError });
    await store.getState().refresh();
    await store.getState().refresh();
    expect(store.getState()).toMatchObject({ statusError: 'ipc down', isLoading: false, repoRoot: '/repo' });
    expect(store.getState().changes).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith('error', 'ipc down');
    await store.getState().refresh();
    expect(store.getState().statusError).toBeNull();
  });

  it('S7 clear() resets statusError', async () => {
    const store = createGitStore({ load: async () => ({ repoRoot: '/repo', changes: [], statusError: 'x' }) });
    await store.getState().refresh();
    store.getState().clear();
    expect(store.getState().statusError).toBeNull();
  });
});

class TestPluginBase {
  constructor(readonly app: CoPluginApp, readonly manifest: PluginManifest) {}
  onload(): void {}
}

// 完整插件:配置 / 布局探测正常,status 的结果由参数决定
async function loadPlugin(status: () => Partial<PluginShellExecResult>) {
  const exec = vi.fn(async (_cmd: string, args: readonly string[]) => {
    if (args.includes('--is-inside-work-tree')) return res({ stdout: 'true\n\n/repo/.git\n/repo/.git\n/repo\n' });
    if (isStatus(args)) return res(status());
    return res({});
  });
  const app = {
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
    shell: { exec, execStream: vi.fn() },
    notifications: { show: vi.fn() },
  } as unknown as CoPluginApp;
  globalThis.co = {
    Plugin: TestPluginBase,
    React: { createElement: vi.fn(() => null) },
    PermissionError: class PermissionError extends Error {},
    z: {},
  };
  detectRepoMock.mockResolvedValue({ ok: true, root: '/repo' });
  const PluginClass = (await import('../../main')).default;
  const plugin = new PluginClass(app, { id: 'git-viewer' } as PluginManifest);
  await plugin.onload();
  return { plugin, app };
}

describe('plugin refresh when git status is unusable', () => {
  it('S8 status fails: no list, the repository stays open (not restricted), statusError says why; a later successful refresh clears it', async () => {
    let status: Partial<PluginShellExecResult> = { exitCode: 128, stderr: 'fatal: index file corrupt\n' };
    const { plugin } = await loadPlugin(() => status);
    await plugin.store.getState().refresh();
    expect(plugin.store.getState()).toMatchObject({
      repoRoot: '/repo', changes: [], restriction: null, statusError: 'git status failed (fatal: index file corrupt)',
    });

    status = { stdout: 'M  a.txt\0' };
    await plugin.store.getState().refresh();
    expect(plugin.store.getState()).toMatchObject({ repoRoot: '/repo', statusError: null });
    expect(plugin.store.getState().changes).toHaveLength(1);
  });

  it('S9 status truncated: the complete records are listed, and statusError marks the list as incomplete', async () => {
    const { plugin } = await loadPlugin(() => ({ stdout: 'M  a.txt\0?? b.txt\0 M cut', truncated: true }));
    await plugin.store.getState().refresh();
    expect(plugin.store.getState().changes.map((c) => c.path)).toEqual(['a.txt', 'b.txt']);
    expect(plugin.store.getState().statusError).toBe('git status output was too large; the list of changes is incomplete');
  });
});

describe('plugin refresh: the fingerprint is read before the list it is stored with', () => {
  const isV2 = (args: readonly string[]) => args.includes('--porcelain=v2');
  const isV1 = (args: readonly string[]) => args.includes('--porcelain=v1');

  it('S13 each refresh runs the fingerprint status (v2) first and the list status (v1) second, and stores the two together; a change between the two reads leaves an older fingerprint in the store, never a newer one', async () => {
    let n = 0;
    const { plugin, app } = await loadPlugin(() => ({ stdout: `M  a.txt\0#${++n}` }));
    const exec = vi.mocked(app.shell.exec);
    exec.mockClear();
    await plugin.store.getState().refresh();
    const statusCalls = exec.mock.calls.map((call) => call[1] as readonly string[]).filter(isStatus);
    expect(statusCalls.map((args) => (isV2(args) ? 'v2' : isV1(args) ? 'v1' : '?'))).toEqual(['v2', 'v1']);
    // 指纹是第一次(更早的)status 的输出
    expect(plugin.store.getState().statusFingerprint).toBe('M  a.txt\0#1');
  });

  it('S14 a fingerprint that cannot be read is stored as null (the list is still shown); with an unusable status the fingerprint read before it is kept', async () => {
    const { plugin, app } = await loadPlugin(() => ({ stdout: 'M  a.txt\0' }));
    const exec = vi.mocked(app.shell.exec);
    const base = exec.getMockImplementation()!;
    exec.mockImplementation(async (cmd, args, opts) =>
      isV2(args as readonly string[]) ? res({ exitCode: 128, stderr: 'fatal' }) : base(cmd, args, opts));
    await plugin.store.getState().refresh();
    expect(plugin.store.getState()).toMatchObject({ statusFingerprint: null, statusError: null });
    expect(plugin.store.getState().changes).toHaveLength(1);

    exec.mockImplementation(async (cmd, args, opts) =>
      isV1(args as readonly string[]) ? res({ exitCode: 128, stderr: 'fatal: index file corrupt' }) : isV2(args as readonly string[]) ? res({ stdout: 'fp' }) : base(cmd, args, opts));
    await plugin.store.getState().refresh();
    expect(plugin.store.getState()).toMatchObject({ statusFingerprint: 'fp', statusError: 'git status failed (fatal: index file corrupt)' });
  });
});

describe('panel when the status is unavailable', () => {
  const headApp = () => {
    // rev-parse --verify HEAD 成功 → 有 HEAD,Amend 复选框可用
    const exec = vi.fn(async () => res({ stdout: 'abc\n' }));
    return { shell: { exec }, notifications: { show: vi.fn() } } as unknown as CoPluginApp;
  };
  const staged = [{ path: 'a.txt', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' }] as const;

  it('S10 shows a non-dismissable alert with the reason, and Commit is disabled even with staged files and a message', async () => {
    const store = createGitStore({
      load: async () => ({ repoRoot: '/repo', changes: [...staged], statusError: 'git status output was too large; the list of changes is incomplete' }),
    });
    store.getState().setCommitMessage('subject');
    render(<GitViewerPanel app={headApp()} store={store} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Could not read the repository status: git status output was too large; the list of changes is incomplete. Commit and Amend are disabled until a refresh succeeds.',
    );
    expect(alert.querySelector('button')).toBeNull();
    const commit = screen.getByRole('button', { name: 'Commit staged changes' }) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    expect(screen.getByText('Status unavailable')).toBeTruthy();
  });

  it('S11 Amend (which does not need staged files) is disabled too; with a usable status the same state leaves it enabled', async () => {
    const make = (statusError?: string) => {
      const store = createGitStore({ load: async () => ({ repoRoot: '/repo', changes: [], ...(statusError ? { statusError } : {}) }) });
      store.setState({ commitMessage: 'reword', amend: true });
      return store;
    };
    const broken = render(<GitViewerPanel app={headApp()} store={make('git status failed (timed out)')} />);
    await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: 'Amend last commit' }) as HTMLButtonElement).disabled).toBe(true);
    broken.unmount();

    const store = make();
    render(<GitViewerPanel app={headApp()} store={store} />);
    await vi.waitFor(() => expect(store.getState().isLoading).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
    await vi.waitFor(() => expect((screen.getByRole('button', { name: 'Amend last commit' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('S12 a restriction takes precedence over the status alert', async () => {
    const store = createGitStore({ load: async () => ({ repoRoot: null, changes: [], restriction: 'Git commands are disabled for this repository', statusError: 'x' }) });
    render(<GitViewerPanel store={store} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Git commands are disabled for this repository');
  });
});
