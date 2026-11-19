// @vitest-environment jsdom
// 宿主吊销插件后,`notifications.show` 本身同步抛 PERMISSION_DENIED(宿主 scoped-app 的 assertLiveUi)。
// 每个通知入口都要接住它:退回面板内 banner(或静默记录),不再抛出——否则 catch 分支里的报告本身抛出,
// 留下未处理的 rejection,成功路径上的刷新 / 收尾也被跳过。
import React, { useSyncExternalStore } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_CHANGED_MESSAGE } from '../../panel/CommitEditor';
import { CommitEditor } from '../../panel/CommitEditor';
import { DiffView } from '../../panel/DiffView';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import { SettingsTab } from '../../panel/SettingsTab';
import { SettingsBus } from '../../lib/settings-bus';
import { _resetRestoreCache } from '../../git/unstage-file';
import type { CommitResult } from '../../git/git-commit';
import type { FileChange } from '../../git/status-scanner';
import type { CoPluginApp, PluginManifest, PluginShellExecResult } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';

const REJECTED = 'too many active shell execs';
const reject = () => Promise.reject(new Error(REJECTED));
const REVOKED = "PERMISSION_DENIED: plugin 'git-viewer' cannot use notifications.show after it was revoked";
/** 吊销后的宿主:show 同步抛出。 */
const revokedNotifications = () => ({
  show: vi.fn(() => {
    throw new Error(REVOKED);
  }),
});

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  warn.mockRestore();
  cleanup();
  _resetRestoreCache();
});
// 未处理的 rejection 在下一轮事件循环才报告
const settle = () => new Promise((r) => setTimeout(r, 20));

function result(partial: Partial<PluginShellExecResult>): PluginShellExecResult {
  return { stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false, ...partial };
}

// —— CommitEditor ——

function renderEditor(opts: {
  readonly amend?: boolean;
  readonly commit?: () => Promise<CommitResult>;
  readonly readHeadSha?: () => Promise<string | null>;
  readonly readFingerprint?: () => Promise<string>;
} = {}) {
  const notifications = revokedNotifications();
  const app = { shell: { exec: vi.fn() }, notifications } as unknown as CoPluginApp;
  const store = createGitStore();
  const refresh = vi.fn(async () => undefined);
  store.setState({
    repoRoot: '/repo',
    commitMessage: opts.amend ? 'head subject' : 'subject',
    amend: opts.amend ?? false,
    amendHead: opts.amend ? 'sha' : null,
    statusFingerprint: 'fp',
    refresh,
  });
  const commit = vi.fn(opts.commit ?? (async () => ({ ok: true as const })));
  function Harness() {
    const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
    return (
      <CommitEditor
        app={app}
        store={store}
        repoRoot={state.repoRoot}
        commitMessage={state.commitMessage}
        stagedCount={1}
        amend={state.amend}
        commitInFlight={state.commitInFlight}
        commit={commit}
        readSubject={async () => 'subject'}
        readHeadMessage={async () => 'head subject'}
        hasHeadCommit={async () => true}
        readHeadSha={opts.readHeadSha ?? (async () => 'sha')}
        detectHooks={async () => ({ kind: 'none' as const })}
        readFingerprint={opts.readFingerprint ?? (async () => 'fp')}
      />
    );
  }
  render(<Harness />);
  return { store, notifications, commit, refresh };
}

describe('CommitEditor: notifications.show throws (plugin revoked)', () => {
  it('N1 git commit refused and the error toast refused too: the error goes to the panel banner, the commit count is back to 0, no unhandled rejection', async () => {
    const { store, notifications } = renderEditor({ commit: reject });
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    await vi.waitFor(() => expect(store.getState().banner).toEqual({ kind: 'error', message: `Commit failed: ${REJECTED}`, dismissable: true }));
    await settle();
    expect(notifications.show).toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ commitsInFlight: 0, commitInFlight: false, commitMessage: 'subject' });
    expect(unhandled).toEqual([]);
  });

  it('N2 a warning (repository changed) whose toast is refused goes to the panel banner, no unhandled rejection', async () => {
    const { store, commit } = renderEditor({ readFingerprint: async () => 'other' });
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    await vi.waitFor(() => expect(store.getState().banner).toEqual({ kind: 'warn', message: REPO_CHANGED_MESSAGE, dismissable: true }));
    await settle();
    expect(commit).not.toHaveBeenCalled();
    expect(store.getState().commitsInFlight).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('N3 the commit went through but the success toast is refused: reported in the banner (not as a failure), the editor is cleared, no unhandled rejection', async () => {
    const { store, refresh } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    await vi.waitFor(() => expect(store.getState().banner).toEqual({ kind: 'info', message: 'Committed: subject', dismissable: true }));
    await settle();
    expect(refresh).toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ commitMessage: '', commitsInFlight: 0 });
    expect(unhandled).toEqual([]);
  });

  it('N4 an amend that left HEAD unchanged, toast refused: "HEAD unchanged" goes to the banner, no unhandled rejection', async () => {
    const { store } = renderEditor({ amend: true });
    fireEvent.click(screen.getByRole('button', { name: 'Amend last commit' }));
    await vi.waitFor(() => expect(store.getState().banner).toEqual({ kind: 'warn', message: 'HEAD unchanged', dismissable: true }));
    await settle();
    expect(store.getState().commitsInFlight).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('N5 checking Amend: reading HEAD refused and the error toast refused: Amend goes back off, the error is in the banner, no unhandled rejection', async () => {
    const { store } = renderEditor({ readHeadSha: reject });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Amend last commit' }));
    await vi.waitFor(() => expect(store.getState().banner).toEqual({ kind: 'error', message: `Failed to read HEAD commit message: ${REJECTED}`, dismissable: true }));
    await settle();
    expect(store.getState()).toMatchObject({ amend: false, commitMessage: 'subject' });
    expect(unhandled).toEqual([]);
  });
});

// —— GitViewerPanel(文件级 Stage / Unstage / Discard)——

function renderPanel(changes: readonly FileChange[], exec: ReturnType<typeof vi.fn>) {
  const notifications = revokedNotifications();
  const shellExec = vi.fn(async (cmd: string, args: readonly string[], opts?: unknown) => {
    if (args.includes('rev-parse')) return result({ stdout: 'HEAD\n' });
    if (args.includes('ls-files') || args.includes('ls-tree')) return result({});
    return exec(cmd, args, opts);
  });
  const app = {
    shell: { exec: shellExec },
    fs: {
      lstat: async (path: string) => {
        const isFile = /\.[a-z]+$/.test(path);
        return { size: 1, mtimeMs: 0, isFile, isDirectory: !isFile, isSymlink: false };
      },
    },
    notifications,
  } as unknown as CoPluginApp;
  const refresh = vi.fn(async () => undefined);
  const store = createGitStore();
  store.setState({
    repoRoot: '/repo',
    changes: [...changes],
    selected: changes[0] ? { path: changes[0].path, mode: 'changed' } : null,
    refresh,
  });
  render(<GitViewerPanel app={app} store={store} />);
  refresh.mockClear();
  return { notifications, refresh, store };
}

const untracked: FileChange = { path: 'new.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' };
const modified: FileChange = { path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' };

describe('GitViewerPanel: notifications.show throws (plugin revoked)', () => {
  it('N6 Stage refused by the host and the error toast refused: the error is in the banner, the write count is back to 0, no unhandled rejection', async () => {
    const { store } = renderPanel([untracked], vi.fn(reject));
    fireEvent.click(screen.getByRole('button', { name: 'Stage file new.txt' }));
    await vi.waitFor(() => expect(store.getState().banner).toEqual({ kind: 'error', message: REJECTED, dismissable: true }));
    await settle();
    expect(store.getState().writesInFlight).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('N7 Stage went through, success toast refused: "Staged" is in the banner, refreshed, no unhandled rejection', async () => {
    const { store, refresh } = renderPanel([untracked], vi.fn().mockResolvedValue(result({})));
    fireEvent.click(screen.getByRole('button', { name: 'Stage file new.txt' }));
    await vi.waitFor(() => expect(store.getState().banner).toEqual({ kind: 'info', message: 'Staged new.txt', dismissable: true }));
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.getState().writesInFlight).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('N8 Discard file went through, success toast refused: the panel still refreshes, the drawer reaches success, "Discarded" is in the banner, no unhandled rejection', async () => {
    const { store, refresh } = renderPanel([modified], vi.fn().mockResolvedValue(result({})));
    fireEvent.click(screen.getByRole('button', { name: 'Discard file src/a.ts' }));
    fireEvent.change(screen.getByLabelText('Type "discard" to confirm:'), { target: { value: 'discard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard file' }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await settle();
    expect(store.getState().banner).toEqual({ kind: 'info', message: 'Discarded src/a.ts', dismissable: true });
    expect(store.getState().writesInFlight).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

// —— DiffView(hunk 级)——

function renderDiff(exec: ReturnType<typeof vi.fn>) {
  const notifications = revokedNotifications();
  const app = { shell: { exec }, notifications } as unknown as CoPluginApp;
  const refresh = vi.fn(async () => undefined);
  const store = createGitStore();
  store.setState({ repoRoot: '/repo', refresh });
  render(
    <DiffView
      app={app}
      store={store}
      change={modified}
      diff={{ ok: true, path: 'src/a.ts', original: 'old', modified: 'new', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n', isUntracked: false }}
    />,
  );
  return { store, refresh, notifications };
}

function confirmDiscardHunk() {
  fireEvent.click(screen.getByRole('button', { name: /Discard hunk at/ }));
  fireEvent.change(screen.getByLabelText('Type "discard" to confirm:'), { target: { value: 'discard' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discard hunk' }));
}

describe('DiffView: notifications.show throws (plugin revoked)', () => {
  it('N9 Discard hunk refused by the host and the error toast refused: the drawer shows the error, the banner too, no unhandled rejection', async () => {
    const { store } = renderDiff(vi.fn(reject));
    confirmDiscardHunk();
    await vi.waitFor(() => expect(store.getState().banner).toEqual({ kind: 'error', message: REJECTED, dismissable: true }));
    await settle();
    expect(screen.getByRole('button', { name: 'Retry discard hunk' })).toBeTruthy();
    expect(screen.getByText(REJECTED, { selector: '.cgv-preview-error' })).toBeTruthy();
    expect(store.getState().writesInFlight).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('N10 Discard hunk went through, the "Hunk discarded" toast refused: the panel still refreshes, no unhandled rejection', async () => {
    const { store, refresh } = renderDiff(vi.fn().mockResolvedValue(result({})));
    confirmDiscardHunk();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await settle();
    expect(store.getState().writesInFlight).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

// —— SettingsTab ——

describe('SettingsTab: notifications.show throws (plugin revoked)', () => {
  it('N11 saving the interval fails and the warning toast is refused: the choice goes back, the failure is logged, no unhandled rejection', async () => {
    const app = {
      dataStore: { read: vi.fn(async () => null), write: vi.fn(async () => { throw new Error('disk full'); }) },
      notifications: revokedNotifications(),
    } as unknown as CoPluginApp;
    render(<SettingsTab app={app} pluginId="git-viewer" bus={new SettingsBus()} />);
    await waitFor(() => expect(screen.getByLabelText('5 seconds (default)')).toHaveProperty('checked', true));
    fireEvent.click(screen.getByLabelText('10 seconds'));
    await waitFor(() => expect(app.notifications?.show).toHaveBeenCalled());
    await settle();
    expect(screen.getByLabelText('5 seconds (default)')).toHaveProperty('checked', true);
    expect(warn).toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});

// —— 插件入口(main.ts)——

class TestPluginBase {
  readonly app: CoPluginApp;
  readonly manifest: PluginManifest;
  constructor(app: CoPluginApp, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }
  onload(): void {}
}

describe('plugin onload: notifications.show throws (plugin revoked)', () => {
  afterEach(() => {
    vi.resetModules();
    globalThis.co = undefined;
    document.head.innerHTML = '';
  });

  it('N12 fs scope denied and the warning toast refused: scopeReady still settles as "deny" (not "error", not rejected), the warning is in the banner', async () => {
    globalThis.co = { Plugin: TestPluginBase, React: { createElement: vi.fn(() => null) }, PermissionError: class extends Error {}, z: {} };
    const PluginClass = (await import('../../main')).default;
    const app = {
      panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      ribbon: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      workspace: { getRoot: vi.fn(async () => '/repo') },
      fs: { realpath: vi.fn(), requestScope: vi.fn(async () => 'deny') },
      shell: { exec: vi.fn(), execStream: vi.fn() },
      dock: { openPanel: vi.fn() },
      notifications: revokedNotifications(),
    } as unknown as CoPluginApp;
    const plugin = new PluginClass(app, { id: 'git-viewer' });
    await plugin.onload();
    await expect(plugin.scopeReady).resolves.toBe('deny');
    expect(plugin.store.getState().banner).toEqual({ kind: 'warn', message: 'fs scope denied; jump-back disabled', dismissable: true });
    await settle();
    expect(unhandled).toEqual([]);
  });
});
