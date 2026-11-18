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
import { tryNotify } from '../lib/notify';
import { visibleText } from '../lib/visible-text';
import { COMMIT_IN_PROGRESS_TITLE } from './FileList';
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
  /**
   * 面板自己的文件写操作(Stage / Unstage / Discard)正在进行(git-store 的 writesInFlight > 0):暂存区正在被改,
   * Commit / Amend 禁用。点击时以 store 为准再查一次(见 onCommit)。
   */
  readonly fileOpInFlight?: boolean;
  /**
   * 有 Commit / Amend 正在进行(git-store 的 commitInFlight)——也可能是面板关掉之前、上一个 CommitEditor 发起的。
   * 此时 Commit / Amend 禁用;点击时以 store 为准再查一次(见 onCommit)。
   */
  readonly commitInFlight?: boolean;
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

// 面板自己的 Stage / Unstage / Discard 还在进行:暂存区正在被改。按钮此时本是禁用的(见 fileOpInFlight);
// 这是点击与重新渲染之间的兜底。
export const FILE_OP_IN_FLIGHT_MESSAGE =
  'A stage, unstage or discard is still running, so the staged changes are not settled yet. Nothing was committed — wait for it to finish, review the view and commit again.';

// 点击之后(读当前指纹期间、或 hooks 确认框开着的时候)面板里又开始了一次 Stage / Unstage / Discard:
// 指纹读到的可能是它落盘之前的 index,而 `git commit` 读到的是之后的。
export const FILE_OP_DURING_COMMIT_MESSAGE =
  'A stage, unstage or discard ran after you clicked, so the staged changes may not be what you reviewed. Nothing was committed — review the view and commit again.';

export const COMMIT_WAITS_FOR_FILE_OP_TITLE = 'Wait for the stage / unstage / discard to finish';

// 已有一次 Commit / Amend 在进行(例如面板关掉之前发起、还没结束的那次)。按钮此时本是禁用的;这是点击与重新渲染
// 之间的兜底。不起第二个 `git commit`。
export const COMMIT_ALREADY_RUNNING_MESSAGE =
  'A commit is already running. Nothing else was committed — wait for it to finish, review the view and commit again.';

/**
 * 点击 Commit / Amend 那一刻屏幕上的内容的身份。必须在 onCommit 里**任何 await 之前**同步取:之后每一个
 * await 期间,在途的 refresh 都可能落盘、把 store 换成用户没看过的内容。
 */
interface ShownSnapshot {
  readonly fingerprint: string | null;
  readonly refreshVersion: number;
  /** git-store 的 writeVersion:之后若有面板写操作开始过,它会变。 */
  readonly writeVersion: number;
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
  return {
    fingerprint: state.statusFingerprint,
    refreshVersion: state.refreshVersion,
    writeVersion: state.writeVersion,
    ...stagedDiffOf(state),
  };
}

/** 从取快照到现在,面板有没有开始过写操作(或仍有写操作在进行)。 */
function fileWriteSince(shown: ShownSnapshot, now: GitViewerState): boolean {
  return now.writesInFlight > 0 || now.writeVersion !== shown.writeVersion;
}

/** 从取快照到现在,屏幕上的内容有没有被换过(refresh 落盘;或同一个选中的 Staged 行的 diff 换了一份)。 */
function shownReplaced(shown: ShownSnapshot, now: GitViewerState): boolean {
  if (now.refreshVersion !== shown.refreshVersion) return true;
  const current = stagedDiffOf(now);
  return current.stagedDiffKey === shown.stagedDiffKey && current.stagedDiff !== shown.stagedDiff;
}

function showWarning(app: CoPluginApp, store: StoreApi<GitViewerState>, message: string): void {
  if (tryNotify(app, { kind: 'warning', message: visibleText(message) })) return;
  store.getState().setBanner({ kind: 'warn', message, dismissable: true });
}

function showInfo(app: CoPluginApp, store: StoreApi<GitViewerState>, message: string): void {
  if (tryNotify(app, { kind: 'info', message: visibleText(message) })) return;
  store.getState().setBanner({ kind: 'info', message, dismissable: true });
}

function showError(app: CoPluginApp, store: StoreApi<GitViewerState>, message: string): void {
  if (tryNotify(app, { kind: 'error', message: visibleText(message) })) return;
  store.getState().setBanner({ kind: 'error', message, dismissable: true });
}

/** rejection 的原因(宿主拒绝执行时是 Error)。 */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  fileOpInFlight = false,
  commitInFlight = false,
  commit = gitCommit as CommitFn,
  readSubject = readLastCommitSubject as ReadSubjectFn,
  readHeadMessage = defaultReadHeadMessage as ReadSubjectFn,
  hasHeadCommit = defaultHasHeadCommit,
  readHeadSha = defaultReadHeadSha as ReadSubjectFn,
  detectHooks = defaultDetectRepoHooks,
  readFingerprint = readStatusHash,
}: CommitEditorProps) {
  const [committing, setCommitting] = useState(false);
  // 这个 CommitEditor 自己的提交在进行,或别处(面板关掉之前的那个 CommitEditor)发起的提交还没结束
  const busy = committing || commitInFlight;
  // 提交前 hooks 确认:非 null 时显示提示,用户点确认才真正提交(每次提交都重新检测与确认)。
  // `shown`:打开确认框的那次点击时屏幕上的内容——确认之后拿它比较(确认框开着的时候有 refresh 落盘 → 中止)。
  const [hooksPrompt, setHooksPrompt] = useState<{
    readonly hooks: Exclude<RepoHooks, { kind: 'none' }>;
    readonly shown: ShownSnapshot;
  } | null>(null);
  const [headHasCommit, setHeadHasCommit] = useState<boolean | null>(
    amend ? true : null,
  );
  // 检查"有没有上一个提交"被宿主拒绝(并发 exec 上限、插件被吊销):原因写进复选框的 title。
  // headHasCommit 此时是 null——Amend 不可勾选、不可提交(fail-closed)。
  const [headCheckError, setHeadCheckError] = useState<string | null>(null);
  const toggleTokenRef = useRef(0);
  // 勾选 Amend 之后用户有没有动过编辑框:读 HEAD 的信息要起两个 git 进程,这期间打的字不能被预填覆盖
  const editedSinceAmendRef = useRef(false);
  const enabled =
    (amend
      ? canAmend(commitMessage, stagedCount, headHasCommit === true)
      : canCommit(commitMessage, stagedCount)) &&
    !busy &&
    !statusUnavailable &&
    !fileOpInFlight &&
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
    setHeadCheckError(null);
    hasHeadCommit(app, repoRoot).then(
      (hasHead) => {
        if (!cancelled) setHeadHasCommit(hasHead);
      },
      (err: unknown) => {
        // 宿主拒绝执行:HEAD 状态未知(null)——不放开 Amend;原因显示在复选框上
        if (cancelled) return;
        setHeadHasCommit(null);
        setHeadCheckError(reasonOf(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [app, repoRoot, hasHeadCommit]);

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    editedSinceAmendRef.current = true;
    store.getState().setCommitMessage(event.target.value);
  };

  // 关掉 Amend 并放回勾选前的草稿(没有记下草稿时为空)
  const restoreDraft = () => {
    store.getState().setCommitMessage(store.getState().amendDraft ?? '');
    store.getState().setAmend(false);
  };

  const onAmendToggle = async (next: boolean) => {
    const token = ++toggleTokenRef.current;
    if (!next) {
      // 取消勾选:放回勾选前的草稿(Amend 模式下改过的文本不保留——它是 HEAD 的信息,不是草稿;见 README)
      restoreDraft();
      return;
    }
    if (!app || !repoRoot) return;

    // 勾选前的草稿先记下(store 里,面板关掉再打开也在),编辑框换成 HEAD 的信息
    store.getState().setAmendDraft(commitMessage);
    store.getState().setCommitMessage('');
    store.getState().setAmend(true);
    editedSinceAmendRef.current = false;
    // 先读 HEAD 的提交 id,再读它的信息:两次读取之间 HEAD 若变了,记下的 id 是旧的,Amend 时判为"变了"而中止
    // (反过来——id 新、信息旧——会放行)。
    let headSha: string | null;
    let headMessage: string | null;
    try {
      headSha = await readHeadSha(app, repoRoot);
      headMessage = headSha === null ? null : await readHeadMessage(app, repoRoot);
    } catch (err) {
      // 宿主拒绝执行(并发 exec 上限、插件被吊销):与读不到同样处理——关掉 Amend、放回草稿,并说明原因。
      // 已被更新的一次勾选 / 取消勾选取代时什么都不做。
      if (token !== toggleTokenRef.current) return;
      restoreDraft();
      showError(app, store, `Failed to read HEAD commit message: ${reasonOf(err)}`);
      return;
    }
    if (token !== toggleTokenRef.current) return;

    if (headMessage === null) {
      restoreDraft();
      showError(app, store, 'Failed to read HEAD commit message');
      return;
    }

    // 照常记下载入的信息(amendMessage):onCommit 拿它判断"预填的信息有没有被改过"。
    store.getState().setAmend(true, headSha, headMessage);
    // 等待期间用户已经在编辑框里打字:保留用户的文本,不预填(此前预填到达时把它覆盖了)
    if (editedSinceAmendRef.current) return;
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
    // 已有提交在进行(按钮还没来得及禁用;或面板关掉之前发起的那次):不起第二个 `git commit`,也不打开确认框
    if (atClick.commitInFlight) {
      setHooksPrompt(null);
      showWarning(app, store, COMMIT_ALREADY_RUNNING_MESSAGE);
      return;
    }
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
    // 面板自己的写操作在进行(按钮还没来得及禁用),或 hooks 确认框开着的时候开始过一次:暂存区不是用户看过的那份
    if (fileWriteSince(shown, atClick)) {
      setHooksPrompt(null);
      showWarning(app, store, atClick.writesInFlight > 0 ? FILE_OP_IN_FLIGHT_MESSAGE : FILE_OP_DURING_COMMIT_MESSAGE);
      return;
    }

    // 从这里起直到结束,面板的文件写操作不可用(见 GitViewerPanel / FileList / DiffView)——与上面的检查在同一个
    // 同步段里:两次点击谁先到,另一方就看得到它。结束时只结束这一次(endCommit),不清掉别处的提交——
    // 包括只打开了 hooks 确认框就 return 的这条路径。
    setCommitting(true);
    const endCommit = store.getState().beginCommit();
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
      // 点击之后(读指纹、读 HEAD 期间)面板开始过写操作:指纹可能读在它落盘之前。提交期间写操作按钮是禁用的,
      // 这是兜底;放在紧挨着 `git commit` 的位置,之后不再有 await。
      if (fileWriteSince(shown, store.getState())) {
        await store.getState().refresh();
        showWarning(app, store, FILE_OP_DURING_COMMIT_MESSAGE);
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

      // 以下是提交已经成功之后:读不到(含宿主拒绝执行)只影响提示文案,不报告为失败
      let noOp = false;
      if (amend && headBefore !== null) {
        let headAfter: string | null;
        try {
          headAfter = await readHeadSha(app, repoRoot);
        } catch {
          headAfter = null;
        }
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
          showWarning(app, store, 'HEAD unchanged');
        } else {
          showInfo(app, store, `Amended HEAD: ${truncateSubject(subject ?? 'staged changes')}`);
        }
      } else {
        showInfo(app, store, `Committed: ${truncateSubject(subject ?? 'staged changes')}`);
      }
    } catch (err) {
      // 宿主拒绝执行(每窗口并发 exec 上限、插件被吊销……)以 rejection 到这里:读 HEAD、读指纹之外的 git 调用
      // 与 `git commit` 本身。照常报告,不留未处理的 rejection;信息与 Amend 状态保留,可以重试。
      showError(app, store, `${amend ? 'Amend' : 'Commit'} failed: ${reasonOf(err)}`);
    } finally {
      setCommitting(false);
      endCommit();
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
        disabled={busy}
      />
      <div className="cgv-amend-row">
        <label className="cgv-amend-label">
          <input
            type="checkbox"
            checked={amend}
            // 已勾选时总可以取消(放回草稿)——包括 HEAD 状态未知(null)的时候;勾选仍要求确知有上一个提交
            disabled={(!amend && headHasCommit !== true) || busy}
            title={
              headCheckError !== null
                ? visibleText(`Could not check for a last commit (${headCheckError}). Reopen the panel to try again.`)
                : undefined
            }
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
          <span className="cgv-hooks-warning">{visibleText(describeRepoHooks(hooksPrompt.hooks))}</span>
          <div className="cgv-hooks-actions">
            <button
              type="button"
              className="cgv-commit-btn"
              onClick={() => setHooksPrompt(null)}
              disabled={busy}
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
            commitInFlight && !committing
              ? COMMIT_IN_PROGRESS_TITLE
              : fileOpInFlight
              ? COMMIT_WAITS_FOR_FILE_OP_TITLE
              : amend
                ? 'Amend rewrites HEAD - avoid pushed commits'
                : 'Commit staged changes'
          }
        >
          {busy ? (amend ? 'Amending...' : 'Committing...') : (amend ? 'Amend' : 'Commit')}
        </button>
      </div>
    </section>
  );
}
