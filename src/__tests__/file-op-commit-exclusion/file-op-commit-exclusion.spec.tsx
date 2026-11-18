// @vitest-environment jsdom
// 面板自己的文件写操作(Stage / Unstage / Discard,文件级与 hunk 级)与 Commit / Amend 互斥。
// 此前 Commit 的快照只看 refresh 与 diff:点 Stage 之后紧接着点 Commit,`git add` 在提交前的确认之后落盘,
// 提交里多出点击时只在 Changes 区的文件(复核者实测:强制时序下提交了 `f,x`)。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMIT_WAITS_FOR_FILE_OP_TITLE,
  CommitEditor,
  FILE_OP_DURING_COMMIT_MESSAGE,
  FILE_OP_IN_FLIGHT_MESSAGE,
} from '../../panel/CommitEditor';
import { COMMIT_IN_PROGRESS_MESSAGE, COMMIT_IN_PROGRESS_TITLE } from '../../panel/FileList';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import type { CommitResult } from '../../git/git-commit';
import type { FileChange } from '../../git/status-scanner';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';
import { _resetRestoreCache } from '../../git/unstage-file';

afterEach(() => {
  cleanup();
  _resetRestoreCache();
});

const ok = (partial: Partial<PluginShellExecResult> = {}): PluginShellExecResult => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: false,
  ...partial,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('the store counts the panel’s own file writes', () => {
  it('X1 beginWrite: in-flight count +1 and the write version +1; the returned end() takes the count back down once (a second call does nothing); the version only grows — refresh and clear do not reset it', async () => {
    const store = createGitStore({ load: async () => ({ repoRoot: '/r', changes: [] }) });
    expect(store.getState()).toMatchObject({ writesInFlight: 0, writeVersion: 0, commitInFlight: false });
    const endA = store.getState().beginWrite();
    const endB = store.getState().beginWrite();
    expect(store.getState()).toMatchObject({ writesInFlight: 2, writeVersion: 2 });
    endA();
    endA();
    expect(store.getState()).toMatchObject({ writesInFlight: 1, writeVersion: 2 });
    await store.getState().refresh();
    store.getState().clear();
    expect(store.getState()).toMatchObject({ writesInFlight: 1, writeVersion: 2 });
    endB();
    expect(store.getState()).toMatchObject({ writesInFlight: 0, writeVersion: 2 });
    store.getState().setCommitInFlight(true);
    expect(store.getState().commitInFlight).toBe(true);
    store.getState().setCommitInFlight(false);
    expect(store.getState().commitInFlight).toBe(false);
  });
});

function renderEditor(opts: {
  readonly fileOpInFlight?: boolean;
  readonly readFingerprint?: () => Promise<string>;
  readonly commit?: () => Promise<CommitResult>;
} = {}) {
  const notifications = { show: vi.fn() };
  const app = { shell: { exec: vi.fn() }, notifications } as unknown as CoPluginApp;
  const refresh = vi.fn(async () => undefined);
  const store = createGitStore();
  store.setState({ repoRoot: '/repo', commitMessage: 'subject', statusFingerprint: 'fp', refresh });
  const commit = vi.fn(opts.commit ?? (async () => ({ ok: true as const })));
  render(
    <CommitEditor
      app={app}
      store={store}
      repoRoot="/repo"
      commitMessage="subject"
      stagedCount={1}
      fileOpInFlight={opts.fileOpInFlight}
      commit={commit}
      readSubject={async () => 'subject'}
      hasHeadCommit={async () => true}
      readHeadSha={async () => 'sha'}
      detectHooks={async () => ({ kind: 'none' as const })}
      readFingerprint={opts.readFingerprint ?? (async () => 'fp')}
    />,
  );
  const button = () => screen.getByRole('button', { name: 'Commit staged changes' }) as HTMLButtonElement;
  return { app, store, commit, refresh, notifications, button };
}

describe('Commit / Amend wait for the panel’s own file writes', () => {
  it('X2 while a file write is in flight the Commit button is disabled and says why', () => {
    const { button } = renderEditor({ fileOpInFlight: true });
    expect(button().disabled).toBe(true);
    expect(button().title).toBe(COMMIT_WAITS_FOR_FILE_OP_TITLE);
  });

  it('X3 a write already in flight at the click (the button had not re-rendered yet): nothing is read, nothing is committed, the warning says to wait', async () => {
    const readFingerprint = vi.fn(async () => 'fp');
    const { store, commit, notifications, button } = renderEditor({ readFingerprint });
    store.getState().beginWrite();
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    await act(async () => { await Promise.resolve(); });
    expect(readFingerprint).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: FILE_OP_IN_FLIGHT_MESSAGE });
    expect(store.getState().commitInFlight).toBe(false);
  });

  it.each([
    ['still running', false],
    ['started and already finished', true],
  ] as const)('X4 a file write that began after the click and is %s when the fingerprint read returns: nothing is committed, the view is refreshed, the warning says a file operation ran after the click', async (_label, finish) => {
    let store!: ReturnType<typeof createGitStore>;
    const readFingerprint = vi.fn(async () => {
      const end = store.getState().beginWrite();
      if (finish) end();
      return 'fp';
    });
    const r = renderEditor({ readFingerprint });
    store = r.store;
    fireEvent.click(r.button());
    await vi.waitFor(() =>
      expect(r.notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: FILE_OP_DURING_COMMIT_MESSAGE }),
    );
    expect(r.commit).not.toHaveBeenCalled();
    expect(r.refresh).toHaveBeenCalledTimes(1);
    expect(store.getState().commitMessage).toBe('subject');
  });

  it('X5 the commit marks itself in flight in the store from the click until it has finished', async () => {
    const gate = deferred<CommitResult>();
    const { store, button } = renderEditor({ commit: () => gate.promise });
    fireEvent.click(button());
    expect(store.getState().commitInFlight).toBe(true);
    await vi.waitFor(() => expect(button().textContent).toBe('Committing...'));
    expect(store.getState().commitInFlight).toBe(true);
    await act(async () => { gate.resolve({ ok: true }); });
    await vi.waitFor(() => expect(store.getState().commitInFlight).toBe(false));
  });
});

// 面板:文件写操作的计数覆盖 git 命令与随后的 refresh;Commit 在途时文件写操作不可用。
function renderPanel(execImpl: (args: readonly string[]) => Promise<PluginShellExecResult> | undefined) {
  const notifications = { show: vi.fn() };
  const changes: FileChange[] = [
    { path: 'f.txt', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' },
    { path: 'x.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
  ];
  const exec = vi.fn(async (_cmd: string, args: readonly string[]) => (await execImpl(args)) ?? ok());
  const app = {
    shell: { exec },
    fs: { lstat: async () => ({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false }) },
    notifications,
  } as unknown as CoPluginApp;
  const refresh = vi.fn(async (): Promise<void> => undefined);
  const store = createGitStore();
  store.setState({ repoRoot: '/repo', changes, selected: null, statusFingerprint: 'fp', commitMessage: 'msg', refresh });
  render(<GitViewerPanel app={app} store={store} />);
  refresh.mockClear();
  const commitButton = () => screen.getByRole('button', { name: 'Commit staged changes' }) as HTMLButtonElement;
  return { app, store, exec, refresh, notifications, commitButton };
}

describe('the panel: file writes and Commit exclude each other', () => {
  it('X6 Stage is clicked and its `git add` is still running: Commit is disabled (with the reason) until the add and the refresh after it are done', async () => {
    const add = deferred<PluginShellExecResult>();
    const { store, refresh, commitButton } = renderPanel((args) => (args.includes('add') ? add.promise : undefined));
    await vi.waitFor(() => expect(commitButton().disabled).toBe(false));
    const refreshGate = deferred<void>();
    refresh.mockImplementation(() => refreshGate.promise);

    fireEvent.click(screen.getByRole('button', { name: 'Stage file x.txt' }));
    expect(store.getState().writesInFlight).toBe(1);
    expect(commitButton().disabled).toBe(true);
    expect(commitButton().title).toBe(COMMIT_WAITS_FOR_FILE_OP_TITLE);

    await act(async () => { add.resolve(ok()); });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(commitButton().disabled).toBe(true);
    await act(async () => { refreshGate.resolve(); });
    await vi.waitFor(() => expect(commitButton().disabled).toBe(false));
    expect(store.getState().writesInFlight).toBe(0);
  });

  it('X7 a failing (rejecting) file write still takes the count back down', async () => {
    const { store, commitButton } = renderPanel((args) => (args.includes('add') ? Promise.reject(new Error('boom')) : undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Stage file x.txt' }));
    await vi.waitFor(() => expect(store.getState().writesInFlight).toBe(0));
    await vi.waitFor(() => expect(commitButton().disabled).toBe(false));
  });

  it('X8 while a commit is in flight the file-level Stage / Unstage buttons are disabled (with the reason); a click that slips through is refused without running git', async () => {
    const { store, exec, notifications } = renderPanel(() => undefined);
    act(() => store.getState().setCommitInFlight(true));
    const stage = screen.getByRole('button', { name: 'Stage file x.txt' }) as HTMLButtonElement;
    const unstage = screen.getByRole('button', { name: 'Unstage file f.txt' }) as HTMLButtonElement;
    expect(stage.disabled).toBe(true);
    expect(unstage.disabled).toBe(true);
    expect(stage.title).toBe(COMMIT_IN_PROGRESS_TITLE);

    // 按钮还没重新渲染时的点击(store 已经标记,DOM 还是可用的):拒绝,不起任何 git。
    // 先拿到"可用时"那一版的 onClick,再标记——等价于标记与点击之间 React 还没重新渲染。
    act(() => store.getState().setCommitInFlight(false));
    exec.mockClear();
    const enabledStage = screen.getByRole('button', { name: 'Stage file x.txt' }) as HTMLButtonElement;
    const propsKey = Object.keys(enabledStage).find((key) => key.startsWith('__reactProps$'))!;
    const onClick = (enabledStage as unknown as Record<string, { onClick: () => void }>)[propsKey]!.onClick;
    store.getState().setCommitInFlight(true);
    await act(async () => { onClick(); await Promise.resolve(); });
    expect(exec).not.toHaveBeenCalled();
    expect(notifications.show).toHaveBeenCalledWith({ kind: 'error', message: COMMIT_IN_PROGRESS_MESSAGE });
    expect(store.getState().writesInFlight).toBe(0);
  });
});
