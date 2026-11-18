// @vitest-environment jsdom
import React, { useSyncExternalStore } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AMEND_HEAD_CHANGED_MESSAGE, AMEND_NON_UTF8_MESSAGE, CommitEditor } from '../../panel/CommitEditor';
import type { CommitResult, GitCommitOptions } from '../../git/git-commit';
import type { CoPluginApp } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';

afterEach(() => cleanup());

function appWithShell() {
  const exec = vi.fn();
  const notifications = { show: vi.fn() };
  return {
    app: { shell: { exec }, notifications } as unknown as CoPluginApp,
    notifications,
  };
}

function renderEditor(opts: {
  readonly app?: CoPluginApp;
  readonly message?: string;
  readonly stagedCount?: number;
  readonly repoRoot?: string | null;
  readonly amend?: boolean;
  readonly commit?: (
    app: CoPluginApp,
    repoRoot: string,
    message: string,
    options?: GitCommitOptions,
  ) => Promise<CommitResult>;
  readonly readSubject?: (app: CoPluginApp, repoRoot: string) => Promise<string | null>;
  readonly readHeadMessage?: (app: CoPluginApp, repoRoot: string) => Promise<string | null>;
  readonly hasHeadCommit?: (app: CoPluginApp, repoRoot: string) => Promise<boolean>;
  readonly readHeadSha?: (app: CoPluginApp, repoRoot: string) => Promise<string | null>;
  /** amend 已勾选时,store 里记下的"载入信息时的 HEAD"(默认与 readHeadSha 的默认回答相同)。 */
  readonly amendHead?: string | null;
} = {}) {
  const store = createGitStore();
  store.setState({
    repoRoot: opts.repoRoot === undefined ? '/repo' : opts.repoRoot,
    commitMessage: opts.message ?? 'subject',
    amend: opts.amend ?? false,
    amendHead: opts.amend ? (opts.amendHead === undefined ? 'sha-after' : opts.amendHead) : null,
    statusFingerprint: 'fp', // 提交前确认(commit-editor T31–T35):store 里的指纹与当前读到的相同才提交
  });
  const commit = opts.commit ?? vi.fn(async () => ({ ok: true as const }));
  const readSubject = opts.readSubject ?? vi.fn(async () => 'subject');
  const readHeadMessage = opts.readHeadMessage ?? vi.fn(async () => 'head subject\n\nhead body');
  const hasHeadCommit = opts.hasHeadCommit ?? vi.fn(async () => true);
  const readHeadSha = opts.readHeadSha ?? vi.fn(async () => 'sha-after');
  function Harness() {
    const state = useSyncExternalStore(
      store.subscribe,
      store.getState,
      store.getState,
    );
    return (
      <CommitEditor
        app={opts.app}
        store={store}
        repoRoot={state.repoRoot}
        commitMessage={state.commitMessage}
        stagedCount={opts.stagedCount ?? 1}
        amend={state.amend}
        commit={commit}
        readSubject={readSubject}
        readHeadMessage={readHeadMessage}
        hasHeadCommit={hasHeadCommit}
        readHeadSha={readHeadSha}
        detectHooks={async () => ({ kind: 'none' as const })}
        readFingerprint={async () => 'fp'}
      />
    );
  }
  render(
    <Harness />,
  );
  return { store, commit, readSubject, readHeadMessage, hasHeadCommit, readHeadSha };
}

describe('CommitEditor amend UI', () => {
  it('T20 renders amend controls in a separate row outside commit actions', async () => {
    const { app } = appWithShell();
    renderEditor({ app });

    const checkbox = await screen.findByRole('checkbox', { name: 'Amend last commit' });
    expect(checkbox.closest('.cgv-amend-row')).toBeTruthy();
    expect(checkbox.closest('.cgv-commit-actions')).toBeNull();
  });

  it('T21 disables the checkbox when no HEAD commit exists', async () => {
    const { app } = appWithShell();
    renderEditor({ app, hasHeadCommit: vi.fn(async () => false) });

    await vi.waitFor(() => {
      expect((screen.getByLabelText('Amend last commit') as HTMLInputElement).disabled).toBe(true);
    });
  });

  it('T22 toggling amend on pre-fills the textarea with the HEAD message', async () => {
    const { app } = appWithShell();
    const readHeadMessage = vi.fn(async () => 'head subject\n\nhead body');
    const { store } = renderEditor({ app, readHeadMessage, message: 'draft' });

    const checkbox = await screen.findByRole('checkbox', { name: 'Amend last commit' });
    fireEvent.click(checkbox);

    await vi.waitFor(() => {
      expect(readHeadMessage).toHaveBeenCalledWith(app, '/repo');
      expect(store.getState().amend).toBe(true);
      expect(store.getState().commitMessage).toBe('head subject\n\nhead body');
    });
  });

  it('T23 toggling amend off clears the message and amend state', async () => {
    const { app } = appWithShell();
    const { store } = renderEditor({ app, amend: true, message: 'head subject' });

    const checkbox = await screen.findByRole('checkbox', { name: 'Amend last commit' });
    fireEvent.click(checkbox);

    expect(store.getState().amend).toBe(false);
    expect(store.getState().commitMessage).toBe('');
  });

  it('T24 ignores a stale readHeadMessage result after amend is toggled off', async () => {
    const { app } = appWithShell();
    let resolveHead: (value: string | null) => void = () => undefined;
    const readHeadMessage = vi.fn(
      async () =>
        new Promise<string | null>((resolve) => {
          resolveHead = resolve;
        }),
    );
    const { store } = renderEditor({ app, readHeadMessage, message: 'draft' });
    const checkbox = await screen.findByRole('checkbox', { name: 'Amend last commit' });

    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    resolveHead('late head message');

    await vi.waitFor(() => {
      expect(store.getState().amend).toBe(false);
      expect(store.getState().commitMessage).toBe('');
    });
  });

  it('T25 labels the button Amend when amend mode is on', async () => {
    const { app } = appWithShell();
    renderEditor({ app, amend: true, message: 'head subject' });

    expect((await screen.findByRole('button', { name: 'Amend last commit' })).textContent).toBe('Amend');
  });

  it('T26 labels the button Commit when amend mode is off', () => {
    const { app } = appWithShell();
    renderEditor({ app, amend: false });

    expect(screen.getByRole('button', { name: 'Commit staged changes' }).textContent).toBe('Commit');
  });

  it('T27 amend submit calls commit with amend true', async () => {
    const { app } = appWithShell();
    const commit = vi.fn(async () => ({ ok: true as const }));
    renderEditor({ app, amend: true, message: 'head subject', commit });

    fireEvent.click(await screen.findByRole('button', { name: 'Amend last commit' }));

    await vi.waitFor(() => {
      expect(commit).toHaveBeenCalledWith(app, '/repo', 'head subject', { amend: true });
    });
  });

  it('T28 amend no-op shows HEAD unchanged instead of Amended HEAD', async () => {
    const { app, notifications } = appWithShell();
    const readHeadSha = vi.fn()
      .mockResolvedValueOnce('same-sha')
      .mockResolvedValueOnce('same-sha');
    renderEditor({ app, amend: true, amendHead: 'same-sha', message: 'head subject', readHeadSha });

    fireEvent.click(await screen.findByRole('button', { name: 'Amend last commit' }));

    await vi.waitFor(() => {
      expect(notifications.show).toHaveBeenCalledWith({
        kind: 'warning',
        message: 'HEAD unchanged',
      });
    });
  });

  it('T29 amend changed SHA shows Amended HEAD with the real subject', async () => {
    const { app, notifications } = appWithShell();
    const readHeadSha = vi.fn()
      .mockResolvedValueOnce('before')
      .mockResolvedValueOnce('after');
    renderEditor({
      app,
      amend: true,
      amendHead: 'before',
      message: 'new subject',
      readHeadSha,
      readSubject: vi.fn(async () => 'new subject'),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Amend last commit' }));

    await vi.waitFor(() => {
      expect(notifications.show).toHaveBeenCalledWith({
        kind: 'info',
        message: 'Amended HEAD: new subject',
      });
    });
  });

  it('T30 amend failure preserves message and amend state', async () => {
    const { app, notifications } = appWithShell();
    const commit = vi.fn(async () => ({ ok: false as const, error: 'amend failed' }));
    const { store } = renderEditor({ app, amend: true, message: 'head subject', commit });

    fireEvent.click(await screen.findByRole('button', { name: 'Amend last commit' }));

    await vi.waitFor(() => {
      expect(store.getState().amend).toBe(true);
      expect(store.getState().commitMessage).toBe('head subject');
      expect(notifications.show).toHaveBeenCalledWith({
        kind: 'error',
        message: 'amend failed',
      });
    });
  });

  it('T31 shows visible pushed-commit warning text in amend mode', () => {
    const { app } = appWithShell();
    renderEditor({ app, amend: true, message: 'head subject' });

    expect(screen.getByText('Will rewrite HEAD - avoid pushed commits')).toBeTruthy();
  });

  it('T32 successful vanilla commit enables the amend checkbox for fresh repos', async () => {
    const { app } = appWithShell();
    renderEditor({ app, hasHeadCommit: vi.fn(async () => false), message: 'first commit' });
    const checkbox = await screen.findByRole('checkbox', { name: 'Amend last commit' });
    await vi.waitFor(() => expect((checkbox as HTMLInputElement).disabled).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    await vi.waitFor(() => {
      expect((checkbox as HTMLInputElement).disabled).toBe(false);
    });
  });

  it('T33 readHeadMessage failure shows an error and leaves amend off', async () => {
    const { app, notifications } = appWithShell();
    const { store } = renderEditor({ app, readHeadMessage: vi.fn(async () => null) });

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Amend last commit' }));

    await vi.waitFor(() => {
      expect(store.getState().amend).toBe(false);
      expect(notifications.show).toHaveBeenCalledWith({
        kind: 'error',
        message: 'Failed to read HEAD commit message',
      });
    });
  });
  it('T34 a HEAD message that arrives with U+FFFD in it (bytes that were not valid UTF-8) is still pre-filled, with a warning that amending saves it as shown; an ordinary message raises none', async () => {
    const lossy = appWithShell();
    const first = renderEditor({ app: lossy.app, readHeadMessage: vi.fn(async () => 'caf\uFFFD subject'), message: '' });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Amend last commit' }));
    await vi.waitFor(() => expect(first.store.getState().commitMessage).toBe('caf\uFFFD subject'));
    expect(lossy.notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: AMEND_NON_UTF8_MESSAGE });
    expect(first.store.getState().amend).toBe(true);
    cleanup();

    const plain = appWithShell();
    const second = renderEditor({ app: plain.app, readHeadMessage: vi.fn(async () => 'café subject'), message: '' });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Amend last commit' }));
    await vi.waitFor(() => expect(second.store.getState().commitMessage).toBe('café subject'));
    expect(plain.notifications.show).not.toHaveBeenCalled();
  });
  // 编辑框里预填的是"勾选 Amend 时的 HEAD"的信息:Amend 只改写那个提交
  describe('Amend rewrites the commit whose message was loaded', () => {
    it('T35 checking Amend records the HEAD commit id together with its message — the id is read first; unchecking forgets it', async () => {
      const { app } = appWithShell();
      const order: string[] = [];
      const readHeadSha = vi.fn(async () => { order.push('sha'); return 'head-1'; });
      const readHeadMessage = vi.fn(async () => { order.push('message'); return 'head subject'; });
      const { store } = renderEditor({ app, readHeadSha, readHeadMessage, message: '' });

      const checkbox = await screen.findByRole('checkbox', { name: 'Amend last commit' });
      fireEvent.click(checkbox);
      await vi.waitFor(() => expect(store.getState()).toMatchObject({ amend: true, amendHead: 'head-1', commitMessage: 'head subject' }));
      expect(order).toEqual(['sha', 'message']);

      fireEvent.click(checkbox);
      expect(store.getState()).toMatchObject({ amend: false, amendHead: null });
    });

    it('T36 HEAD is a different commit when Amend is clicked (a commit was made or rewritten elsewhere after the message was loaded): nothing is amended, Amend is turned off, the text stays, the view is refreshed and a warning says why', async () => {
      const { app, notifications } = appWithShell();
      const commit = vi.fn(async () => ({ ok: true as const }));
      const { store } = renderEditor({ app, amend: true, amendHead: 'head-1', message: 'old head message', commit, readHeadSha: vi.fn(async () => 'head-2') });
      const refresh = vi.fn(async () => {});
      store.setState({ refresh });

      fireEvent.click(await screen.findByRole('button', { name: 'Amend last commit' }));

      await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: AMEND_HEAD_CHANGED_MESSAGE }));
      expect(AMEND_HEAD_CHANGED_MESSAGE).toBe(
        'HEAD is no longer the commit whose message was loaded when "Amend last commit" was checked. Nothing was amended and Amend was turned off — check it again to load the current message.',
      );
      expect(commit).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(store.getState()).toMatchObject({ amend: false, amendHead: null, commitMessage: 'old head message' });
    });

    it('T37 fail-closed: HEAD cannot be read at that moment, or no commit id was recorded with the Amend state → no amend either', async () => {
      for (const [amendHead, sha] of [['head-1', null], [null, 'head-1']] as const) {
        const { app, notifications } = appWithShell();
        const commit = vi.fn(async () => ({ ok: true as const }));
        const { store } = renderEditor({ app, amend: true, amendHead, message: 'm', commit, readHeadSha: vi.fn(async () => sha) });
        store.setState({ refresh: vi.fn(async () => {}) });
        fireEvent.click(await screen.findByRole('button', { name: 'Amend last commit' }));
        await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: AMEND_HEAD_CHANGED_MESSAGE }));
        expect(commit).not.toHaveBeenCalled();
        cleanup();
      }
    });

    it('T38 a HEAD id that cannot be read when Amend is checked is handled like an unreadable message: Amend goes back off with an error, and the message is not asked for', async () => {
      const { app, notifications } = appWithShell();
      const readHeadMessage = vi.fn(async () => 'head subject');
      const { store } = renderEditor({ app, readHeadSha: vi.fn(async () => null), readHeadMessage, message: '' });
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Amend last commit' }));
      await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'error', message: 'Failed to read HEAD commit message' }));
      expect(store.getState()).toMatchObject({ amend: false, amendHead: null });
      expect(readHeadMessage).not.toHaveBeenCalled();
    });
  });
});
