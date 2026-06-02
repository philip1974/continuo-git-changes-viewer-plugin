// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommitEditor } from '../../panel/CommitEditor';
import type { CommitResult } from '../../git/git-commit';
import type { CoPluginApp } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';

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
} = {}) {
  const store = createGitStore();
  store.setState({
    repoRoot: opts.repoRoot === undefined ? '/repo' : opts.repoRoot,
    commitMessage: opts.message ?? 'subject',
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

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    expect((screen.getByRole('button', { name: 'Commit staged changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('T19 zero staged files keep Commit disabled and do not shell out', () => {
    const { app, exec } = appWithShell();
    renderEditor({ stagedCount: 0, app });

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
      expect(commit).toHaveBeenCalledWith(app, '/repo', 'subject');
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
});
