import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { canAmend } from '../git/can-amend';
import { canCommit } from '../git/can-commit';
import {
  gitCommit,
  readLastCommitSubject,
  type CommitResult,
  type GitCommitOptions,
} from '../git/git-commit';
import {
  hasHeadCommit as defaultHasHeadCommit,
  readHeadMessage as defaultReadHeadMessage,
  readHeadSha as defaultReadHeadSha,
} from '../git/head-meta';
import {
  describeRepoHooks,
  detectRepoHooks as defaultDetectRepoHooks,
  type RepoHooks,
} from '../git/repo-hooks';
import type { CoPluginApp } from '../sdk/types';
import type { GitViewerState } from '../state/git-store';

type CommitFn = (
  app: CoPluginApp,
  repoRoot: string,
  message: string,
  options?: GitCommitOptions,
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
  readonly amend?: boolean;
  readonly commit?: CommitFn;
  readonly readSubject?: ReadSubjectFn;
  readonly readHeadMessage?: ReadSubjectFn;
  readonly hasHeadCommit?: (app: CoPluginApp, repoRoot: string) => Promise<boolean>;
  readonly readHeadSha?: ReadSubjectFn;
  readonly detectHooks?: (app: CoPluginApp, repoRoot: string) => Promise<RepoHooks>;
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
  amend = false,
  commit = gitCommit as CommitFn,
  readSubject = readLastCommitSubject as ReadSubjectFn,
  readHeadMessage = defaultReadHeadMessage as ReadSubjectFn,
  hasHeadCommit = defaultHasHeadCommit,
  readHeadSha = defaultReadHeadSha as ReadSubjectFn,
  detectHooks = defaultDetectRepoHooks,
}: CommitEditorProps) {
  const [committing, setCommitting] = useState(false);
  // 提交前 hooks 确认:非 null 时显示提示,用户点确认才真正提交(每次提交都重新检测与确认)。
  const [hooksPrompt, setHooksPrompt] = useState<Exclude<RepoHooks, { kind: 'none' }> | null>(
    null,
  );
  const [headHasCommit, setHeadHasCommit] = useState<boolean | null>(
    amend ? true : null,
  );
  const toggleTokenRef = useRef(0);
  const enabled =
    (amend
      ? canAmend(commitMessage, stagedCount, headHasCommit === true)
      : canCommit(commitMessage, stagedCount)) &&
    !committing &&
    repoRoot !== null &&
    app !== undefined;

  useEffect(() => {
    setHooksPrompt(null);
  }, [repoRoot]);

  useEffect(() => {
    if (!app || !repoRoot) {
      setHeadHasCommit(null);
      return;
    }

    let cancelled = false;
    void hasHeadCommit(app, repoRoot).then((hasHead) => {
      if (!cancelled) setHeadHasCommit(hasHead);
    });
    return () => {
      cancelled = true;
    };
  }, [app, repoRoot, hasHeadCommit]);

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    store.getState().setCommitMessage(event.target.value);
  };

  const onAmendToggle = async (next: boolean) => {
    const token = ++toggleTokenRef.current;
    if (!next) {
      store.getState().setCommitMessage('');
      store.getState().setAmend(false);
      return;
    }
    if (!app || !repoRoot) return;

    store.getState().setCommitMessage('');
    store.getState().setAmend(true);
    const headMessage = await readHeadMessage(app, repoRoot);
    if (token !== toggleTokenRef.current) return;

    if (headMessage === null) {
      store.getState().setAmend(false);
      showError(app, store, 'Failed to read HEAD commit message');
      return;
    }

    store.getState().setCommitMessage(headMessage);
  };

  const onCommit = async (hooksConfirmed = false) => {
    if (!enabled || !app || !repoRoot) return;

    setCommitting(true);
    try {
      if (!hooksConfirmed) {
        let hooks: RepoHooks;
        try {
          hooks = await detectHooks(app, repoRoot);
        } catch (err) {
          hooks = {
            kind: 'unknown',
            reason: err instanceof Error ? err.message : String(err),
          };
        }
        if (hooks.kind !== 'none') {
          setHooksPrompt(hooks);
          return;
        }
      }
      setHooksPrompt(null);
      const headBefore = amend ? await readHeadSha(app, repoRoot) : null;
      const result = await commit(
        app,
        repoRoot,
        commitMessage,
        // 只有用户在确认框里点了"运行 hooks"才放开联网(见 exec.ts);无 hooks 的提交断网运行
        hooksConfirmed ? { amend, hooksConfirmed: true } : { amend },
      );
      if (!result.ok) {
        showError(app, store, result.error || (amend ? 'Amend failed' : 'Commit failed'));
        return;
      }

      let noOp = false;
      if (amend && headBefore !== null) {
        const headAfter = await readHeadSha(app, repoRoot);
        noOp = headAfter !== null && headAfter === headBefore;
      }

      let subject: string | null = null;
      try {
        subject = await readSubject(app, repoRoot);
      } catch {
        subject = null;
      }

      store.getState().setCommitMessage('');
      store.getState().setAmend(false);
      await store.getState().refresh();
      setHeadHasCommit(true);
      if (amend) {
        if (noOp) {
          if (typeof app.notifications?.show === 'function') {
            app.notifications.show({ kind: 'warning', message: 'HEAD unchanged' });
          } else {
            store.getState().setBanner({
              kind: 'warn',
              message: 'HEAD unchanged',
              dismissable: true,
            });
          }
        } else {
          showInfo(app, store, `Amended HEAD: ${truncateSubject(subject ?? 'staged changes')}`);
        }
      } else {
        showInfo(app, store, `Committed: ${truncateSubject(subject ?? 'staged changes')}`);
      }
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
          stagedCount === 0 && !amend
            ? 'Stage some changes first...'
            : 'Commit message (subject + optional body)'
        }
        value={commitMessage}
        onChange={onChange}
        rows={2}
        spellCheck={false}
        disabled={committing}
      />
      <div className="cgv-amend-row">
        <label className="cgv-amend-label">
          <input
            type="checkbox"
            checked={amend}
            disabled={headHasCommit !== true || committing}
            onChange={(event) => void onAmendToggle(event.target.checked)}
          />
          <span>Amend last commit</span>
        </label>
        {amend ? (
          <span className="cgv-amend-warning">
            Will rewrite HEAD - avoid pushed commits
          </span>
        ) : null}
      </div>
      {hooksPrompt ? (
        <div className="cgv-hooks-confirm" role="alert">
          <span className="cgv-hooks-warning">{describeRepoHooks(hooksPrompt)}</span>
          <div className="cgv-hooks-actions">
            <button
              type="button"
              className="cgv-commit-btn"
              onClick={() => setHooksPrompt(null)}
              disabled={committing}
            >
              Cancel
            </button>
            <button
              type="button"
              className="cgv-commit-btn cgv-hooks-confirm-btn"
              onClick={() => void onCommit(true)}
              disabled={!enabled}
            >
              {amend ? 'Amend and run hooks' : 'Commit and run hooks'}
            </button>
          </div>
        </div>
      ) : null}
      <div className="cgv-commit-actions">
        <span className="cgv-commit-hint">
          {stagedCount === 0 ? 'No staged changes' : `${stagedCount} file(s) staged`}
        </span>
        <button
          type="button"
          className={`cgv-commit-btn${amend ? ' cgv-amend-btn' : ''}`}
          onClick={() => void onCommit(false)}
          disabled={!enabled}
          aria-label={amend ? 'Amend last commit' : 'Commit staged changes'}
          title={
            amend
              ? 'Amend rewrites HEAD - avoid pushed commits'
              : 'Commit staged changes'
          }
        >
          {committing ? (amend ? 'Amending...' : 'Committing...') : (amend ? 'Amend' : 'Commit')}
        </button>
      </div>
    </section>
  );
}
