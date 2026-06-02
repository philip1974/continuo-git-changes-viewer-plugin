import { useState, type ChangeEvent } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { canCommit } from '../git/can-commit';
import {
  gitCommit,
  readLastCommitSubject,
  type CommitResult,
} from '../git/git-commit';
import type { CoPluginApp } from '../sdk/types';
import type { GitViewerState } from '../state/git-store';

type CommitFn = (
  app: CoPluginApp,
  repoRoot: string,
  message: string,
) => Promise<CommitResult>;

type ReadSubjectFn = (
  app: CoPluginApp,
  repoRoot: string,
) => Promise<string | null>;

interface CommitEditorProps {
  readonly app?: CoPluginApp;
  readonly store: StoreApi<GitViewerState>;
  readonly commitMessage: string;
  readonly stagedCount: number;
  readonly repoRoot: string | null;
  readonly commit?: CommitFn;
  readonly readSubject?: ReadSubjectFn;
}

function showInfo(app: CoPluginApp, store: StoreApi<GitViewerState>, message: string): void {
  if (typeof app.notifications?.show === 'function') {
    app.notifications.show({ kind: 'info', message });
    return;
  }
  store.getState().setBanner({ kind: 'info', message, dismissable: true });
}

function showError(app: CoPluginApp, store: StoreApi<GitViewerState>, message: string): void {
  if (typeof app.notifications?.show === 'function') {
    app.notifications.show({ kind: 'error', message });
    return;
  }
  store.getState().setBanner({ kind: 'error', message, dismissable: true });
}

function truncateSubject(subject: string): string {
  return subject.length > 60 ? `${subject.slice(0, 60)}...` : subject;
}

export function CommitEditor({
  app,
  store,
  commitMessage,
  stagedCount,
  repoRoot,
  commit = gitCommit as CommitFn,
  readSubject = readLastCommitSubject as ReadSubjectFn,
}: CommitEditorProps) {
  const [committing, setCommitting] = useState(false);
  const enabled =
    canCommit(commitMessage, stagedCount) &&
    !committing &&
    repoRoot !== null &&
    app !== undefined;

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    store.getState().setCommitMessage(event.target.value);
  };

  const onCommit = async () => {
    if (!enabled || !app || !repoRoot) return;

    setCommitting(true);
    try {
      const result = await commit(app, repoRoot, commitMessage);
      if (!result.ok) {
        showError(app, store, result.error || 'Commit failed');
        return;
      }

      let subject: string | null = null;
      try {
        subject = await readSubject(app, repoRoot);
      } catch {
        subject = null;
      }

      store.getState().setCommitMessage('');
      await store.getState().refresh();
      showInfo(app, store, `Committed: ${truncateSubject(subject ?? 'staged changes')}`);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <section className="cgv-commit-editor" aria-label="Commit changes">
      <textarea
        aria-label="Commit message"
        className="cgv-commit-message"
        placeholder={
          stagedCount === 0
            ? 'Stage some changes first...'
            : 'Commit message (subject + optional body)'
        }
        value={commitMessage}
        onChange={onChange}
        rows={2}
        spellCheck={false}
        disabled={committing}
      />
      <div className="cgv-commit-actions">
        <span className="cgv-commit-hint">
          {stagedCount === 0 ? 'No staged changes' : `${stagedCount} file(s) staged`}
        </span>
        <button
          type="button"
          className="cgv-commit-btn"
          onClick={() => void onCommit()}
          disabled={!enabled}
          aria-label="Commit staged changes"
          title="Commit staged changes"
        >
          {committing ? 'Committing...' : 'Commit'}
        </button>
      </div>
    </section>
  );
}
