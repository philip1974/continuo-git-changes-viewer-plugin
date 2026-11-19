// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommitEditor,
  DIFF_REFRESHING_MESSAGE,
  REPO_CHANGED_MESSAGE,
  repoStateUnconfirmedMessage,
  VIEW_REFRESHED_MESSAGE,
  VIEW_REFRESHING_MESSAGE,
} from '../../panel/CommitEditor';
import type { RepoHooks } from '../../git/repo-hooks';
import type { CommitResult } from '../../git/git-commit';
import type { CoPluginApp } from '../../sdk/types';
import { createGitStore, type GitStoreLoadResult } from '../../state/git-store';

afterEach(() => cleanup());

function appWithShell() {
  const exec = vi.fn();
  const notifications = { show: vi.fn() };
  return {
    app: { shell: { exec }, notifications } as unknown as CoPluginApp,
    exec,
    notifications,
  };
}

function renderEditor(opts: {
  readonly message?: string;
  readonly stagedCount?: number;
  readonly repoRoot?: string | null;
  readonly app?: CoPluginApp;
  readonly commit?: (app: CoPluginApp, repoRoot: string, message: string) => Promise<CommitResult>;
  readonly readSubject?: (app: CoPluginApp, repoRoot: string) => Promise<string | null>;
  readonly readFingerprint?: (app: CoPluginApp, repoRoot: string) => Promise<string>;
  readonly storedFingerprint?: string | null;
  readonly amend?: boolean;
  readonly detectHooks?: (app: CoPluginApp, repoRoot: string) => Promise<RepoHooks>;
  /** store 的 load(T36 起:让真正的 refresh 落盘)。 */
  readonly load?: () => Promise<GitStoreLoadResult>;
} = {}) {
  const store = createGitStore(opts.load ? { load: opts.load } : {});
  store.setState({
    repoRoot: opts.repoRoot === undefined ? '/repo' : opts.repoRoot,
    commitMessage: opts.message ?? 'subject',
    statusFingerprint: opts.storedFingerprint === undefined ? 'fp' : opts.storedFingerprint, // 提交前确认(commit-editor T31–T35):store 里的指纹与当前读到的相同才提交
  });
  const commit = opts.commit ?? vi.fn(async () => ({ ok: true as const }));
  const readSubject = opts.readSubject ?? vi.fn(async () => 'subject');
  render(
    <CommitEditor
      app={opts.app}
      store={store}
      repoRoot={opts.repoRoot === undefined ? '/repo' : opts.repoRoot}
      commitMessage={opts.message ?? 'subject'}
      stagedCount={opts.stagedCount ?? 1}
      commit={commit}
      readSubject={readSubject}
      amend={opts.amend}
      hasHeadCommit={async () => true}
      readHeadSha={async () => 'sha'}
      detectHooks={opts.detectHooks ?? (async () => ({ kind: 'none' as const }))}
      readFingerprint={opts.readFingerprint ?? (async () => 'fp')}
    />,
  );
  return { store, commit, readSubject };
}

describe('CommitEditor', () => {
  it('T16 binds textarea value to store.commitMessage', () => {
    renderEditor({ message: 'stored subject\n\nbody', app: appWithShell().app });

    expect((screen.getByLabelText('Commit message') as HTMLTextAreaElement).value).toBe(
      'stored subject\n\nbody',
    );
  });

  it('T17 writes textarea changes to store.setCommitMessage', () => {
    const { store } = renderEditor({ message: '', app: appWithShell().app });

    fireEvent.change(screen.getByLabelText('Commit message'), {
      target: { value: 'next subject' },
    });

    expect(store.getState().commitMessage).toBe('next subject');
  });

  it('T18 empty messages keep Commit disabled and do not shell out', () => {
    const { app, exec } = appWithShell();
    renderEditor({ message: '', app });
    exec.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    expect((screen.getByRole('button', { name: 'Commit staged changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('T19 zero staged files keep Commit disabled and do not shell out', () => {
    const { app, exec } = appWithShell();
    renderEditor({ stagedCount: 0, app });
    exec.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    expect(screen.getByText('No staged changes')).toBeTruthy();
    expect(exec).not.toHaveBeenCalled();
  });

  it('T20 unknown repo root keeps Commit disabled and does not shell out', () => {
    const { app, exec } = appWithShell();
    renderEditor({ repoRoot: null, app });

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    expect((screen.getByRole('button', { name: 'Commit staged changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('T21 missing app keeps Commit disabled', () => {
    renderEditor();

    expect((screen.getByRole('button', { name: 'Commit staged changes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('T22 in-flight committing blocks duplicate commit calls', async () => {
    const { app } = appWithShell();
    let resolveCommit: (value: CommitResult) => void = () => undefined;
    const commit = vi.fn(
      async () =>
        new Promise<CommitResult>((resolve) => {
          resolveCommit = resolve;
        }),
    );
    renderEditor({ app, commit });

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    // 提交前先异步检测 hooks,commit 在其后调用
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    expect(commit).toHaveBeenCalledTimes(1);
    resolveCommit({ ok: true });
    await vi.waitFor(() => expect(screen.getByText('Commit')).toBeTruthy());
  });

  it('T23 valid Commit invokes the injected commit function', async () => {
    const { app } = appWithShell();
    const commit = vi.fn(async () => ({ ok: true as const }));
    renderEditor({ app, commit, message: 'subject' });

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    await vi.waitFor(() => {
      expect(commit).toHaveBeenCalledWith(app, '/repo', 'subject', { amend: false });
    });
  });

  it('T24 successful commit clears the stored message', async () => {
    const { app } = appWithShell();
    const { store } = renderEditor({ app, message: 'subject' });

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    await vi.waitFor(() => {
      expect(store.getState().commitMessage).toBe('');
    });
  });

  it('T25 success reads the real subject and shows it in the toast', async () => {
    const { app, notifications } = appWithShell();
    const readSubject = vi.fn(async () => 'hook rewritten subject');
    renderEditor({ app, readSubject, message: 'user subject' });

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    await vi.waitFor(() => {
      expect(readSubject).toHaveBeenCalledWith(app, '/repo');
      expect(notifications.show).toHaveBeenCalledWith({
        kind: 'info',
        message: 'Committed: hook rewritten subject',
      });
    });
  });

  it('T26 failed commit preserves the message and shows an error toast', async () => {
    const { app, notifications } = appWithShell();
    const commit = vi.fn(async () => ({ ok: false as const, error: 'hook failed' }));
    const { store } = renderEditor({ app, commit, message: 'subject' });

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    await vi.waitFor(() => {
      expect(store.getState().commitMessage).toBe('subject');
      expect(notifications.show).toHaveBeenCalledWith({
        kind: 'error',
        message: 'hook failed',
      });
    });
  });

  it('T27 shows Committing... while commit is in flight', async () => {
    const { app } = appWithShell();
    const commit = vi.fn(
      async () =>
        new Promise<CommitResult>(() => {
          // keep pending
        }),
    );
    renderEditor({ app, commit });

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    await vi.waitFor(() => {
      expect(screen.getByText('Committing...')).toBeTruthy();
    });
  });

  it('T28 truncates long subjects with ASCII ellipsis', async () => {
    const { app, notifications } = appWithShell();
    const readSubject = vi.fn(async () => 'a'.repeat(70));
    renderEditor({ app, readSubject });

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    await vi.waitFor(() => {
      expect(notifications.show).toHaveBeenCalledWith({
        kind: 'info',
        message: `Committed: ${'a'.repeat(60)}...`,
      });
    });
  });
  // 面板显示的是最近一次 refresh 读到的状态;`git commit` 提交的是此刻的 index。提交前拿当前指纹与 store 里
  // 和列表一起读出的那份比较。
  describe('the index is confirmed right before the commit', () => {
    const changedSetup = (extra: Parameters<typeof renderEditor>[0] = {}) => {
      const { app, notifications } = appWithShell();
      const commit = vi.fn(async () => ({ ok: true as const }));
      // 仓库在面板读过之后变了:当前指纹 'fp-2',store 里是 'fp'
      const current = { value: 'fp-2' };
      const readFingerprint = vi.fn(async () => current.value);
      const rendered = renderEditor({ app, commit, readFingerprint, message: 'subject', ...extra });
      // refresh 把 store 更新到当前(真实的 load 会连同列表一起读到新指纹)
      const refresh = vi.fn(async () => {
        rendered.store.setState({ statusFingerprint: current.value });
      });
      rendered.store.setState({ refresh });
      return { ...rendered, app, notifications, commit, readFingerprint, refresh, current };
    };

    it('T29 the repository changed since the list was read (fingerprint differs): nothing is committed, the view is refreshed, the user is told, and the message is kept', async () => {
      const { store, notifications, commit, refresh } = changedSetup();

      fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

      await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: REPO_CHANGED_MESSAGE }));
      expect(REPO_CHANGED_MESSAGE).toBe(
        'The repository changed since this view was last refreshed. Nothing was committed — the view is now up to date; review it and commit again.',
      );
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      expect(store.getState().commitMessage).toBe('subject');
      await vi.waitFor(() => expect(screen.getByText('Commit')).toBeTruthy());
    });

    it('T30 after that refresh the same click commits (the stored fingerprint is the current one again); the fingerprint is read for every attempt', async () => {
      const { commit, readFingerprint, refresh, notifications } = changedSetup();

      fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(notifications.show).toHaveBeenCalled());
      fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
      expect(readFingerprint).toHaveBeenCalledTimes(2);
    });

    it('T31 fail-closed: a fingerprint that cannot be read now, or a list that came without one (null in the store), does not commit either — and the message says the state could not be confirmed (with the reason), not that the repository changed', async () => {
      const failing = changedSetup({ readFingerprint: async () => { throw new Error('git status failed (timed out)'); } });
      fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
      await vi.waitFor(() => expect(failing.notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: repoStateUnconfirmedMessage('git status failed (timed out)') }));
      expect(repoStateUnconfirmedMessage('git status failed (timed out)')).toBe(
        'Could not confirm the current state of the repository (git status failed (timed out)). Nothing was committed — try again once the view has refreshed.',
      );
      expect(failing.notifications.show).not.toHaveBeenCalledWith({ kind: 'warning', message: REPO_CHANGED_MESSAGE });
      expect(failing.commit).not.toHaveBeenCalled();
      // 视图随即刷新:持续读不到时由 refresh 把原因挂到面板上(statusError),而不是每次点击都重复同一句
      expect(failing.refresh).toHaveBeenCalledTimes(1);
      cleanup();

      const unknown = changedSetup({ readFingerprint: async () => 'fp', storedFingerprint: null });
      unknown.store.setState({ refresh: vi.fn(async () => {}) });
      fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
      await vi.waitFor(() => expect(unknown.notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: repoStateUnconfirmedMessage(null) }));
      expect(repoStateUnconfirmedMessage(null)).toBe(
        'Could not confirm the current state of the repository. Nothing was committed — try again once the view has refreshed.',
      );
      expect(unknown.commit).not.toHaveBeenCalled();
    });

    it('T32 Amend is confirmed the same way: a changed fingerprint (it includes HEAD) stops the amend and keeps the Amend state and message', async () => {
      const { store, notifications, commit, refresh } = changedSetup({ amend: true });
      store.setState({ amend: true, amendHead: 'sha' });

      fireEvent.click(screen.getByRole('button', { name: 'Amend last commit' }));

      await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: REPO_CHANGED_MESSAGE }));
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      expect(store.getState()).toMatchObject({ amend: true, commitMessage: 'subject' });
    });

    it('T33 with repository hooks the confirmation happens after the user agreed to run them — the last thing before git commit — and a change found then closes the hooks prompt without committing', async () => {
      const present: RepoHooks = { kind: 'present', hooks: ['pre-commit'], hooksPath: null };
      const { commit, readFingerprint, refresh, current, store } = changedSetup({ detectHooks: async () => present });
      current.value = 'fp';

      fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
      const confirm = await screen.findByRole('button', { name: 'Commit and run hooks' });
      expect(readFingerprint).not.toHaveBeenCalled();
      // 用户看着确认框的时候,仓库变了
      current.value = 'fp-3';
      fireEvent.click(confirm);

      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      expect(commit).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Commit and run hooks' })).toBeNull());
      expect(store.getState().commitMessage).toBe('subject');
    });

    it('T35 while the Staged diff on screen is an old one whose replacement is still being read, nothing is committed (an equal fingerprint says the list is current, not that this content is); a Changes diff being refreshed does not hold a commit back', async () => {
      const { app, notifications } = appWithShell();
      const commit = vi.fn(async () => ({ ok: true as const }));
      const readFingerprint = vi.fn(async () => 'fp');
      const { store } = renderEditor({ app, commit, readFingerprint, message: 'subject' });
      store.setState({ diffRefreshingKey: 'staged:src/a.ts' });

      fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
      await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: DIFF_REFRESHING_MESSAGE }));
      expect(DIFF_REFRESHING_MESSAGE).toBe(
        'The staged diff on screen is still being refreshed. Nothing was committed — wait for it to finish, review it and commit again.',
      );
      expect(commit).not.toHaveBeenCalled();
      expect(readFingerprint).not.toHaveBeenCalled();
      expect(store.getState().commitMessage).toBe('subject');
      await vi.waitFor(() => expect(screen.getByText('Commit')).toBeTruthy());

      store.setState({ diffRefreshingKey: 'changed:src/a.ts' });
      fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    });

    // 点击时屏幕上的状态(F1):比较基线必须在任何 await 之前取。此前基线在 `await readFingerprint` 之后才从
    // store 读——在途的 refresh 在这期间落盘,两边都是新指纹,比较通过:点击时屏幕上是 v1,提交的是 v2。
    describe('what was on screen at the click is what gets compared', () => {
      const deferred = <T,>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => { resolve = r; });
        return { promise, resolve };
      };
      // 仓库在终端里变成了 'fp-2';store 的 load 读到的就是它
      const racingSetup = (extra: Parameters<typeof renderEditor>[0] = {}) => {
        const { app, notifications } = appWithShell();
        const commit = vi.fn(async () => ({ ok: true as const }));
        const read = deferred<string>();
        const readFingerprint = vi.fn(() => read.promise);
        const load = vi.fn(async () => ({ repoRoot: '/repo', changes: [], statusFingerprint: 'fp-2' }));
        const rendered = renderEditor({ app, commit, readFingerprint, load, message: 'subject', ...extra });
        return { ...rendered, notifications, commit, read, readFingerprint, load };
      };

      it('T36 a refresh lands while the current fingerprint is being read (the click saw the old list; store and repository now agree on the new one): nothing is committed and the user is told the view was refreshed after the click', async () => {
        const { store, notifications, commit, read, readFingerprint } = racingSetup();

        fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
        await vi.waitFor(() => expect(readFingerprint).toHaveBeenCalledTimes(1));
        await store.getState().refresh();
        expect(store.getState().statusFingerprint).toBe('fp-2');
        read.resolve('fp-2');

        await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: VIEW_REFRESHED_MESSAGE }));
        expect(VIEW_REFRESHED_MESSAGE).toBe(
          'The view was refreshed after you clicked, so it is not what you reviewed. Nothing was committed — review it and commit again.',
        );
        expect(commit).not.toHaveBeenCalled();
        expect(store.getState().commitMessage).toBe('subject');
        await vi.waitFor(() => expect(screen.getByText('Commit')).toBeTruthy());
      });

      it('T37 the same when the refresh changed nothing (same fingerprint): any refresh landing between the click and the comparison stops the commit — the comparison is with the list the click saw, not with whatever the store holds afterwards', async () => {
        const { store, notifications, commit, read, readFingerprint, load } = racingSetup();
        load.mockResolvedValue({ repoRoot: '/repo', changes: [], statusFingerprint: 'fp' });

        fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
        await vi.waitFor(() => expect(readFingerprint).toHaveBeenCalledTimes(1));
        await store.getState().refresh();
        read.resolve('fp');

        await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: VIEW_REFRESHED_MESSAGE }));
        expect(commit).not.toHaveBeenCalled();
        // 视图已是当前的:不再多刷一次
        expect(load).toHaveBeenCalledTimes(1);
      });

      it('T38 a refresh is in flight at the click: nothing is committed and nothing is read — the user is asked to wait', async () => {
        const { store, notifications, commit, readFingerprint } = racingSetup();
        store.setState({ isLoading: true });

        fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

        await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: VIEW_REFRESHING_MESSAGE }));
        expect(VIEW_REFRESHING_MESSAGE).toBe(
          'The view is still being refreshed. Nothing was committed — wait for it to finish, review it and commit again.',
        );
        expect(readFingerprint).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.getByText('Commit')).toBeTruthy());
      });

      it('T39 Amend goes through the same comparison', async () => {
        const { store, notifications, commit, read, readFingerprint } = racingSetup({ amend: true });
        store.setState({ amend: true, amendHead: 'sha' });

        fireEvent.click(screen.getByRole('button', { name: 'Amend last commit' }));
        await vi.waitFor(() => expect(readFingerprint).toHaveBeenCalledTimes(1));
        await store.getState().refresh();
        read.resolve('fp-2');

        await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: VIEW_REFRESHED_MESSAGE }));
        expect(commit).not.toHaveBeenCalled();
        expect(store.getState()).toMatchObject({ amend: true, commitMessage: 'subject' });
      });

      it('T40 with repository hooks the baseline is taken when the first click opens the confirmation: a refresh landing while the prompt is open stops the commit after the user confirms, and closes the prompt', async () => {
        const present: RepoHooks = { kind: 'present', hooks: ['pre-commit'], hooksPath: null };
        const { store, notifications, commit, read, readFingerprint } = racingSetup({ detectHooks: async () => present });

        fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
        const confirm = await screen.findByRole('button', { name: 'Commit and run hooks' });
        // 用户看着确认框的时候,终端里又暂存了内容,自动刷新把面板更新了
        await store.getState().refresh();
        read.resolve('fp-2');
        fireEvent.click(confirm);

        await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: VIEW_REFRESHED_MESSAGE }));
        expect(readFingerprint).toHaveBeenCalledTimes(1);
        expect(commit).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Commit and run hooks' })).toBeNull());
      });

      it('T41 the selected Staged diff on screen was replaced between the click and the comparison (the row was clicked again and is being re-read): nothing is committed', async () => {
        const { store, notifications, commit, read, readFingerprint } = racingSetup();
        const diff = { ok: true } as never;
        store.setState({ selected: { path: 'a', mode: 'staged' }, diffCache: new Map([['staged:a', diff]]) });

        fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
        await vi.waitFor(() => expect(readFingerprint).toHaveBeenCalledTimes(1));
        store.setState({ diffCache: new Map() });
        read.resolve('fp');

        await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'warning', message: VIEW_REFRESHED_MESSAGE }));
        expect(commit).not.toHaveBeenCalled();
      });

      it('T42 nothing landed and the fingerprint is the one the click saw: the commit goes through, however long the read took', async () => {
        const { commit, read, readFingerprint, notifications } = racingSetup();

        fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
        await vi.waitFor(() => expect(readFingerprint).toHaveBeenCalledTimes(1));
        read.resolve('fp');

        await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
        expect(notifications.show).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }));
      });
    });

    it('T34 without notifications the same text goes to the dismissable warning banner', async () => {
      const bare = changedSetup({ app: { shell: { exec: vi.fn() } } as unknown as CoPluginApp });
      fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
      await vi.waitFor(() => expect(bare.store.getState().banner).toEqual({ kind: 'warn', message: REPO_CHANGED_MESSAGE, dismissable: true }));
      expect(bare.commit).not.toHaveBeenCalled();
    });
  });
});
