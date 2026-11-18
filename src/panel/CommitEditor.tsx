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
import { readStatusHash } from '../git/status-hash';
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
  /**
   * 最近一次 refresh 没拿到可信的 status(git-store 的 statusError):暂存区里有什么未知,Commit 与 Amend
   * 都禁用——Amend 不看暂存数(can-amend),否则会把面板没显示的暂存内容一并提交。
   */
  readonly statusUnavailable?: boolean;
  readonly commit?: CommitFn;
  readonly readSubject?: ReadSubjectFn;
  readonly readHeadMessage?: ReadSubjectFn;
  readonly hasHeadCommit?: (app: CoPluginApp, repoRoot: string) => Promise<boolean>;
  readonly readHeadSha?: ReadSubjectFn;
  readonly detectHooks?: (app: CoPluginApp, repoRoot: string) => Promise<RepoHooks>;
  /** 仓库当前的指纹(status-hash);提交前与 store 里那份比较。 */
  readonly readFingerprint?: (app: CoPluginApp, repoRoot: string) => Promise<string>;
}

// 提交前的确认没通过:仓库(index / HEAD)与面板最近一次读到的不同。提交被中止,面板已刷新。
export const REPO_CHANGED_MESSAGE =
  'The repository changed since this view was last refreshed. Nothing was committed — the view is now up to date; review it and commit again.';

function showWarning(app: CoPluginApp, store: StoreApi<GitViewerState>, message: string): void {
  if (typeof app.notifications?.show === 'function') {
    app.notifications.show({ kind: 'warning', message });
    return;
  }
  store.getState().setBanner({ kind: 'warn', message, dismissable: true });
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
  statusUnavailable = false,
  commit = gitCommit as CommitFn,
  readSubject = readLastCommitSubject as ReadSubjectFn,
  readHeadMessage = defaultReadHeadMessage as ReadSubjectFn,
  hasHeadCommit = defaultHasHeadCommit,
  readHeadSha = defaultReadHeadSha as ReadSubjectFn,
  detectHooks = defaultDetectRepoHooks,
  readFingerprint = readStatusHash,
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
    !statusUnavailable &&
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
      // 提交前确认:面板显示的是最近一次 refresh 读到的状态,而 `git commit` 提交的是**此刻**的 index。
      // 两者之间仓库可能已被改动(终端里又 `git add` 了别的内容;自动刷新关着,或还没轮到下一个 tick)。
      // 读一次当前指纹,与 store 里和列表一起读出的那份(statusFingerprint)比较:不同、或读不到 → 不提交,
      // 刷新面板并说明,由用户重新确认。Amend 同样(指纹含 HEAD:被改写的是用户看到的那个提交)。
      // 残余:读指纹与 `git commit` 读 index 之间仍有一个很短的窗口(两次进程启动之间),见 README。
      let current: string | null;
      try {
        current = await readFingerprint(app, repoRoot);
      } catch {
        current = null;
      }
      if (current === null || current !== store.getState().statusFingerprint) {
        await store.getState().refresh();
        showWarning(app, store, REPO_CHANGED_MESSAGE);
        return;
      }
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
          {statusUnavailable
            ? 'Status unavailable'
            : stagedCount === 0
              ? 'No staged changes'
              : `${stagedCount} file(s) staged`}
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
