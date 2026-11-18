// @vitest-environment jsdom
// 宿主拒绝执行(每窗口并发 exec 上限、插件被吊销……)以 rejection 到达。Commit / Amend 的每个入口都要接住它:
// 告诉用户、不留未处理的 rejection、状态回到可重试。
import React, { useSyncExternalStore } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitEditor } from '../../panel/CommitEditor';
import type { CommitResult, GitCommitOptions } from '../../git/git-commit';
import type { CoPluginApp } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';

const REJECTED = 'too many active shell execs';
const reject = () => Promise.reject(new Error(REJECTED));

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  cleanup();
});
// 未处理的 rejection 在下一轮事件循环才报告
const settle = () => new Promise((r) => setTimeout(r, 20));

type ReadFn = (app: CoPluginApp, repoRoot: string) => Promise<string | null>;

function renderEditor(opts: {
  readonly message?: string;
  readonly amend?: boolean;
  readonly commit?: (app: CoPluginApp, repoRoot: string, message: string, options?: GitCommitOptions) => Promise<CommitResult>;
  readonly readHeadSha?: ReadFn;
  readonly readHeadMessage?: ReadFn;
  readonly hasHeadCommit?: (app: CoPluginApp, repoRoot: string) => Promise<boolean>;
} = {}) {
  const notifications = { show: vi.fn() };
  const app = { shell: { exec: vi.fn() }, notifications } as unknown as CoPluginApp;
  const store = createGitStore();
  store.setState({
    repoRoot: '/repo',
    commitMessage: opts.message ?? 'subject',
    amend: opts.amend ?? false,
    amendHead: opts.amend ? 'sha' : null,
    statusFingerprint: 'fp',
  });
  const commit = opts.commit ?? vi.fn(async () => ({ ok: true as const }));
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
        readHeadMessage={opts.readHeadMessage ?? (async () => 'head subject')}
        hasHeadCommit={opts.hasHeadCommit ?? (async () => true)}
        readHeadSha={opts.readHeadSha ?? (async () => 'sha')}
        detectHooks={async () => ({ kind: 'none' as const })}
        readFingerprint={async () => 'fp'}
      />
    );
  }
  render(<Harness />);
  return { app, store, notifications, commit };
}

describe('Commit / Amend: the host refuses to run git', () => {
  it('H1 git commit is refused: an error says so with the reason, the message is kept, the commit count is back to 0, the button is usable again, no unhandled rejection', async () => {
    const commit = vi.fn(reject);
    const { store, notifications } = renderEditor({ commit, message: 'my message' });
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'error', message: `Commit failed: ${REJECTED}` }));
    await settle();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ commitMessage: 'my message', commitsInFlight: 0, commitInFlight: false });
    expect(screen.getByRole('button', { name: 'Commit staged changes' }).textContent).toBe('Commit');
    expect(unhandled).toEqual([]);
  });

  it('H2 Amend: reading HEAD right before amending is refused → nothing is amended, an error with the reason, Amend and the text stay, no unhandled rejection', async () => {
    const commit = vi.fn(async () => ({ ok: true as const }));
    const { store, notifications } = renderEditor({ commit, amend: true, message: 'head subject', readHeadSha: reject });
    fireEvent.click(screen.getByRole('button', { name: 'Amend last commit' }));
    await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'error', message: `Amend failed: ${REJECTED}` }));
    await settle();
    expect(commit).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ amend: true, commitMessage: 'head subject', commitsInFlight: 0 });
    expect(unhandled).toEqual([]);
  });

  it('H3 Amend went through but reading HEAD afterwards is refused: it is reported as amended (not as a failure), the editor is cleared, no unhandled rejection', async () => {
    let reads = 0;
    const readHeadSha = vi.fn(() => (++reads === 1 ? Promise.resolve('sha') : reject()));
    const { store, notifications } = renderEditor({ amend: true, message: 'head subject', readHeadSha });
    fireEvent.click(screen.getByRole('button', { name: 'Amend last commit' }));
    await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'info', message: 'Amended HEAD: subject' }));
    await settle();
    expect(notifications.show).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    expect(store.getState()).toMatchObject({ amend: false, commitMessage: '', commitsInFlight: 0 });
    expect(unhandled).toEqual([]);
  });
});

describe('checking Amend: the host refuses to read HEAD', () => {
  it('H4 reading the HEAD id is refused: Amend goes back off, the draft comes back, an error says why, no unhandled rejection', async () => {
    const readHeadMessage = vi.fn(async () => 'head subject');
    const { store, notifications } = renderEditor({ message: 'my draft', readHeadSha: reject, readHeadMessage });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Amend last commit' }));
    await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'error', message: `Failed to read HEAD commit message: ${REJECTED}` }));
    await settle();
    expect(readHeadMessage).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ amend: false, commitMessage: 'my draft', amendDraft: null, amendHead: null });
    expect((screen.getByLabelText('Commit message') as HTMLTextAreaElement).value).toBe('my draft');
    expect((screen.getByRole('checkbox', { name: 'Amend last commit' }) as HTMLInputElement).checked).toBe(false);
    expect(unhandled).toEqual([]);
  });

  it('H5 reading the HEAD message is refused: the same', async () => {
    const { store, notifications } = renderEditor({ message: 'my draft', readHeadMessage: reject });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Amend last commit' }));
    await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'error', message: `Failed to read HEAD commit message: ${REJECTED}` }));
    await settle();
    expect(store.getState()).toMatchObject({ amend: false, commitMessage: 'my draft', amendDraft: null });
    expect(unhandled).toEqual([]);
  });

  it('H6 a refusal that arrives after Amend was unchecked again changes nothing and reports nothing', async () => {
    let rejectSha: (err: Error) => void = () => undefined;
    const readHeadSha = vi.fn(() => new Promise<string | null>((_resolve, rej) => { rejectSha = rej; }));
    const { store, notifications } = renderEditor({ message: 'my draft', readHeadSha });
    const box = await screen.findByRole('checkbox', { name: 'Amend last commit' });
    fireEvent.click(box);
    fireEvent.click(box); // 取消勾选:草稿已放回
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'typed later' } });
    rejectSha(new Error(REJECTED));
    await settle();
    expect(notifications.show).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ amend: false, commitMessage: 'typed later' });
    expect(unhandled).toEqual([]);
  });
});

describe('checking whether there is a last commit is refused', () => {
  it('H7 the Amend checkbox stays disabled (Amend is not offered on an unknown HEAD), its title says why, no unhandled rejection', async () => {
    renderEditor({ hasHeadCommit: reject });
    await settle();
    const box = screen.getByRole('checkbox', { name: 'Amend last commit' }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.title).toBe(`Could not check for a last commit (${REJECTED}). Reopen the panel to try again.`);
    expect(unhandled).toEqual([]);
  });

  it('H9 after the refused check, a commit goes through: HEAD now certainly has a commit — the checkbox is enabled and its title no longer says the check failed', async () => {
    const { notifications } = renderEditor({ hasHeadCommit: reject, message: 'first' });
    await settle();
    const before = screen.getByRole('checkbox', { name: 'Amend last commit' }) as HTMLInputElement;
    expect(before.title).toContain('Could not check for a last commit');
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'info', message: 'Committed: subject' }));
    const box = screen.getByRole('checkbox', { name: 'Amend last commit' }) as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(box.title).toBe('');
    expect(unhandled).toEqual([]);
  });

  it('H8 already in Amend mode when the check is refused: the Amend button is disabled (null HEAD state opens nothing), but the checkbox can still be unchecked to get the draft back', async () => {
    const commit = vi.fn(async () => ({ ok: true as const }));
    const { store } = renderEditor({ amend: true, message: 'head subject', hasHeadCommit: reject, commit });
    store.setState({ amendDraft: 'my draft' });
    await settle();
    const amendButton = screen.getByRole('button', { name: 'Amend last commit' }) as HTMLButtonElement;
    expect(amendButton.disabled).toBe(true);
    fireEvent.click(amendButton);
    await settle();
    expect(commit).not.toHaveBeenCalled();
    const box = screen.getByRole('checkbox', { name: 'Amend last commit' }) as HTMLInputElement;
    expect(box.disabled).toBe(false);
    fireEvent.click(box);
    expect(store.getState()).toMatchObject({ amend: false, commitMessage: 'my draft' });
    // 取消勾选之后:HEAD 状态未知,复选框重新禁用,不能再勾上
    expect((screen.getByRole('checkbox', { name: 'Amend last commit' }) as HTMLInputElement).disabled).toBe(true);
    expect(unhandled).toEqual([]);
  });
});
