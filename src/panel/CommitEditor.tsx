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
import { cacheKey, type GitViewerState } from '../state/git-store';
import type { DiffResult } from '../git/diff-fetcher';

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

// Amend 时 HEAD 已不是勾选 Amend 时的那个提交:编辑框里的信息是旧提交的,照常执行会用它改写新的 HEAD。
export const AMEND_HEAD_CHANGED_MESSAGE =
  'HEAD is no longer the commit whose message was loaded when "Amend last commit" was checked. ' +
  'Nothing was amended and Amend was turned off — check it again to load the current message.';

export const AMEND_NON_UTF8_MESSAGE =
  'The last commit message contains bytes that are not valid UTF-8. They are shown as \uFFFD, and amending will save the message as shown here.';

// 预填的信息含 U+FFFD 而用户没改过就点 Amend:原提交信息里的那些字节会被改写成 EF BF BD(实测:没有 encoding 头的
// GBK 提交;`--amend --no-edit` 也保不住原字节)。用户多半只想改内容、没打算改信息——拦下并说明。改过则照常。
export const AMEND_NON_UTF8_UNEDITED_MESSAGE =
  'The last commit message contains bytes that are not valid UTF-8, and it has not been edited: amending would replace those bytes with \uFFFD. Nothing was amended — edit the message before amending, or amend in a terminal.';

// 提交前读不到当前指纹(status 失败 / 超时),或面板这份列表本来就没有指纹:无从比较。这不是"仓库变了"。
export const repoStateUnconfirmedMessage = (reason: string | null): string =>
  `Could not confirm the current state of the repository${reason ? ` (${reason})` : ''}. ` +
  'Nothing was committed — try again once the view has refreshed.';

export const DIFF_REFRESHING_MESSAGE =
  'The staged diff on screen is still being refreshed. Nothing was committed — wait for it to finish, review it and commit again.';

// 点击时已有一次 refresh 在途:屏幕上的列表即将被换掉。不读、不比、不提交。
export const VIEW_REFRESHING_MESSAGE =
  'The view is still being refreshed. Nothing was committed — wait for it to finish, review it and commit again.';

// 点击之后、比较之前有 refresh 落盘(或屏幕上选中的 Staged diff 被换掉):屏幕上已不是点击时的那份内容。
export const VIEW_REFRESHED_MESSAGE =
  'The view was refreshed after you clicked, so it is not what you reviewed. Nothing was committed — review it and commit again.';

/**
 * 点击 Commit / Amend 那一刻屏幕上的内容的身份。必须在 onCommit 里**任何 await 之前**同步取:之后每一个
 * await 期间,在途的 refresh 都可能落盘、把 store 换成用户没看过的内容。
 */
interface ShownSnapshot {
  readonly fingerprint: string | null;
  readonly refreshVersion: number;
  /** 选中的是 Staged 区的行时:它的缓存键与屏幕上那份 diff 对象(没读到时 undefined)。 */
  readonly stagedDiffKey: string | null;
  readonly stagedDiff: DiffResult | undefined;
}

function stagedDiffOf(state: GitViewerState): Pick<ShownSnapshot, 'stagedDiffKey' | 'stagedDiff'> {
  const { selected, diffCache } = state;
  if (!selected || selected.mode !== 'staged') return { stagedDiffKey: null, stagedDiff: undefined };
  const key = cacheKey(selected.path, selected.mode);
  return { stagedDiffKey: key, stagedDiff: diffCache.get(key) };
}

function snapshotShown(state: GitViewerState): ShownSnapshot {
  return { fingerprint: state.statusFingerprint, refreshVersion: state.refreshVersion, ...stagedDiffOf(state) };
}

/** 从取快照到现在,屏幕上的内容有没有被换过(refresh 落盘;或同一个选中的 Staged 行的 diff 换了一份)。 */
function shownReplaced(shown: ShownSnapshot, now: GitViewerState): boolean {
  if (now.refreshVersion !== shown.refreshVersion) return true;
  const current = stagedDiffOf(now);
  return current.stagedDiffKey === shown.stagedDiffKey && current.stagedDiff !== shown.stagedDiff;
}

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
  // `shown`:打开确认框的那次点击时屏幕上的内容——确认之后拿它比较(确认框开着的时候有 refresh 落盘 → 中止)。
  const [hooksPrompt, setHooksPrompt] = useState<{
    readonly hooks: Exclude<RepoHooks, { kind: 'none' }>;
    readonly shown: ShownSnapshot;
  } | null>(null);
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
    // 先读 HEAD 的提交 id,再读它的信息:两次读取之间 HEAD 若变了,记下的 id 是旧的,Amend 时判为"变了"而中止
    // (反过来——id 新、信息旧——会放行)。
    const headSha = await readHeadSha(app, repoRoot);
    const headMessage = headSha === null ? null : await readHeadMessage(app, repoRoot);
    if (token !== toggleTokenRef.current) return;

    if (headMessage === null) {
      store.getState().setAmend(false);
      showError(app, store, 'Failed to read HEAD commit message');
      return;
    }

    store.getState().setAmend(true, headSha, headMessage);
    store.getState().setCommitMessage(headMessage);
    // 提交信息同样经宿主按 UTF-8 解码:不是合法 UTF-8 的字节(没有 encoding 头的 Latin-1 / GBK 提交信息)
    // 已经变成 U+FFFD,Amend 会把预填的文本原样写回去。照常预填并说明;没改过就点 Amend 会被拦下(见 onCommit)。
    if (headMessage.includes('\uFFFD')) showWarning(app, store, AMEND_NON_UTF8_MESSAGE);
  };

  const onCommit = async (hooksConfirmed = false) => {
    if (!enabled || !app || !repoRoot) return;

    // —— 以下到 try 之前不得有 await ——
    // 用户看到的是渲染出来的列表与 diff;这里取的是 store 此刻的状态。refresh 在点击前一瞬间落盘、React 还没
    // 渲染(或刚渲染、用户不可能看过)的情形分辨不了——人机时序,见 README 的残余。
    const atClick = store.getState();
    // 预填的信息含 U+FFFD 且一字未改:不 Amend(见 AMEND_NON_UTF8_UNEDITED_MESSAGE)。比较的是将要提交的文本。
    if (amend && atClick.amendMessage !== null && atClick.amendMessage.includes('\uFFFD') && commitMessage === atClick.amendMessage) {
      setHooksPrompt(null);
      showWarning(app, store, AMEND_NON_UTF8_UNEDITED_MESSAGE);
      return;
    }
    // 确认框里的 "…and run hooks":基线是打开确认框的那次点击,不是这一次
    const shown = hooksConfirmed && hooksPrompt ? hooksPrompt.shown : snapshotShown(atClick);
    // 屏幕上的内容正在被换掉:列表的 refresh 在途,或 Staged 区的 diff 是刷新之前读的、新的还没到
    // (git-store 的 diffRefreshingKey——指纹对得上只说明列表是当前的,不说明屏幕上这份内容是)。等它读完。
    const stagedDiffRefreshing = atClick.diffRefreshingKey?.startsWith('staged:') === true;
    if (atClick.isLoading || stagedDiffRefreshing) {
      setHooksPrompt(null);
      showWarning(app, store, atClick.isLoading ? VIEW_REFRESHING_MESSAGE : DIFF_REFRESHING_MESSAGE);
      return;
    }

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
          setHooksPrompt({ hooks, shown });
          return;
        }
      }
      setHooksPrompt(null);
      // 提交前确认:面板显示的是最近一次 refresh 读到的状态,而 `git commit` 提交的是**此刻**的 index。
      // 两者之间仓库可能已被改动(终端里又 `git add` 了别的内容;自动刷新关着,或还没轮到下一个 tick)。
      // 读一次当前指纹,与**点击时**屏幕上那份列表的指纹(shown.fingerprint)比较:不同、或读不到 → 不提交,
      // 刷新面板并说明,由用户重新确认。Amend 同样(指纹含 HEAD:被改写的是用户看到的那个提交)。
      // 残余:读指纹与 `git commit` 读 index 之间仍有一个很短的窗口(两次进程启动之间),见 README。
      //
      // 基线是点击时的快照,不是读完之后 store 里的值:在途的 refresh 可能就在这次 await 期间落盘——那时 store
      // 与仓库都是新的,拿它们互相比较必然相等,而点击时屏幕上是旧内容(实测:点击时显示 v1,提交了 v2)。
      // 所以另外要求快照之后没有任何 refresh 落盘(shownReplaced)。
      let current: string | null;
      let readError: string | null = null;
      try {
        current = await readFingerprint(app, repoRoot);
      } catch (err) {
        current = null;
        readError = err instanceof Error ? err.message : String(err);
      }
      const now = store.getState();
      if (current === null) {
        // 读不到:无从比较(fail-closed)。刷新一次——持续读不到时 load 会把原因挂到面板上(statusError,
        // Commit / Amend 随之禁用、tick 按退避重试),而不是每次点击都得到同一句提示。
        await now.refresh();
        showWarning(app, store, repoStateUnconfirmedMessage(readError));
        return;
      }
      if (shownReplaced(shown, now)) {
        // 视图已被换过。它若仍不是仓库现在的状态,再刷一次;否则已经是当前的,不多刷。
        if (current !== now.statusFingerprint) await now.refresh();
        showWarning(app, store, VIEW_REFRESHED_MESSAGE);
        return;
      }
      if (shown.fingerprint === null) {
        // 这份列表没有指纹(正常的 load 此时会带 statusError、按钮已禁用;这里是兜底)
        await now.refresh();
        showWarning(app, store, repoStateUnconfirmedMessage(null));
        return;
      }
      if (current !== shown.fingerprint) {
        await now.refresh();
        showWarning(app, store, REPO_CHANGED_MESSAGE);
        return;
      }
      const headBefore = amend ? await readHeadSha(app, repoRoot) : null;
      // Amend 只改写"载入信息时的那个提交"。上面的指纹比较只说明仓库与面板最近一次 refresh 时相同;HEAD 在勾选
      // Amend 之后被替换、随后面板又刷新过(自动刷新的 tick)时,指纹是新的,而编辑框里仍是旧提交的信息。
      // 读不到 HEAD、或没有记下载入时的提交 → 同样中止(fail-closed)。
      if (amend && (headBefore === null || headBefore !== store.getState().amendHead)) {
        store.getState().setAmend(false);
        await store.getState().refresh();
        showWarning(app, store, AMEND_HEAD_CHANGED_MESSAGE);
        return;
      }
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
          <span className="cgv-hooks-warning">{describeRepoHooks(hooksPrompt.hooks)}</span>
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
