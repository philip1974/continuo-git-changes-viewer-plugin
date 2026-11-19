import { useEffect, useReducer, useRef, type Dispatch } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { canDiscardHunk } from '../git/can-discard-hunk';
import { canStageHunk } from '../git/can-stage-hunk';
import { canUnstageHunk } from '../git/can-unstage-hunk';
import { MAX_FILE_BYTES, type DiffMode, type DiffResult } from '../git/diff-fetcher';
import { discardHunk } from '../git/discard-hunk';
import { extractHunkPatchFromUnifiedDiff, hasUndecodableText, NON_UTF8_HUNK_NOTE } from '../git/hunk-patch';
import { joinRepoPath } from '../git/path-utils';
import { stageHunk } from '../git/stage-hunk';
import { unstageHunk } from '../git/unstage-hunk';
import type { CoPluginApp } from '../sdk/types';
import { tryNotify } from '../lib/notify';
import { visibleText } from '../lib/visible-text';
import type { FileChange } from '../git/status-scanner';
import type { GitViewerState } from '../state/git-store';
import { COMMIT_IN_PROGRESS_MESSAGE, COMMIT_IN_PROGRESS_TITLE } from './FileList';
import {
  type DrawerAction,
  PreviewDrawer,
  type PreviewDrawerAction,
  previewDrawerReducer,
  type PreviewDrawerState,
} from './PreviewDrawer';

interface DiffViewProps {
  readonly app?: CoPluginApp;
  readonly store: StoreApi<GitViewerState>;
  readonly change: FileChange | null;
  readonly diff: DiffResult | null;
  readonly mode?: DiffMode;
  readonly scopeReady?: Promise<'grant' | 'deny' | 'no-workspace' | 'error'>;
  readonly drawer?: PreviewDrawerState;
  readonly dispatchDrawer?: Dispatch<PreviewDrawerAction>;
  /** 提交正在进行(git-store 的 commitInFlight):hunk 的写操作按钮禁用。 */
  readonly writesBlocked?: boolean;
}

function NewFileView({
  content,
  truncated,
  timedOut,
  symlink,
}: {
  readonly content: string;
  readonly truncated?: boolean;
  readonly timedOut?: boolean;
  readonly symlink?: boolean;
}) {
  // 新增的符号链接:git 存的"内容"是链接目标路径。标明它是链接,不当成文件内容显示。
  // 目标路径同样受整文件读取的大小 / 时间上限约束(伪造的 index 里 mode 120000 的 blob 可以任意大):只读到一部分时照样说明。
  if (symlink) {
    return (
      <>
        <div className="cgv-symlink-note" role="note">
          {`Symbolic link → ${content}`}
        </div>
        {truncated ? (
          <div className="cgv-truncated-note" role="note">
            {timedOut
              ? 'Reading this link took too long — showing only the part of its target that was read.'
              : `Link target too long — showing only the first ${MAX_FILE_BYTES / (1024 * 1024)} MB of it.`}
          </div>
        ) : null}
      </>
    );
  }
  return (
    <>
      <pre className="cgv-new-file">{content || '(empty file)'}</pre>
      {truncated ? (
        <div className="cgv-truncated-note" role="note">
          {timedOut
            ? 'Reading this file took too long — showing only the part that was read. Open the file in an editor to see the rest.'
            : `File too large — showing the first ${MAX_FILE_BYTES / (1024 * 1024)} MB. Open the file in an editor to see the rest.`}
        </div>
      ) : null}
    </>
  );
}

// 新版全文未读取(见 diff-fetcher 的符号链接检查 / index 读取):显示说明,不显示文件内容。
const WITHHELD_NOTICE = {
  symlink: 'Symbolic link — contents are not shown',
  unverified: 'Could not verify that this path is not a symbolic link — contents are not shown',
  'not-regular': 'Not a regular file (directory, pipe or device) — contents are not shown',
  'no-staged-blob': 'No staged file content to show (submodule entry or unresolved merge conflict)',
  // 读取失败,不是仓库的状态:不归咎于子模块 / 冲突,并说明提交仍会包含它
  'staged-unreadable':
    'The staged content of this file could not be read — it is not shown here, but a commit would still include it. Refresh to try again.',
} as const;

// exactCommand 里的路径已按 shell 规则转义(diff-fetcher / shell-quote);为 null 表示路径含控制字符、
// 没有可安全粘贴的命令:不显示命令,Copy 禁用并说明原因。
// 命令里的路径按 POSIX 风格 shell 的引号规则书写(见 shell-quote);PowerShell / cmd 的规则不同。
const COPY_COMMAND_TITLE =
  'Copy this command. It is quoted for POSIX-style shells (sh, bash, zsh, fish), not for PowerShell or cmd.';

function TooLargePlaceholder({
  exactCommand,
  onCopyFailed,
}: {
  readonly exactCommand: string | null;
  readonly onCopyFailed: (reason: string) => void;
}) {
  return (
    <div className="cgv-placeholder">
      <strong>Diff too large</strong>
      {/* 显示可见形式(文件名里的 U+202E 等不会把命令倒过来显示、看不见的字符看得见;不截断);Copy 复制的仍是原命令 */}
      {exactCommand !== null ? <code>{visibleText(exactCommand, Number.POSITIVE_INFINITY)}</code> : null}
      <button
        type="button"
        disabled={exactCommand === null}
        title={
          exactCommand === null
            ? 'No command to copy: this file name contains control characters and cannot be pasted into a terminal safely'
            : COPY_COMMAND_TITLE
        }
        onClick={() => {
          if (exactCommand === null) return;
          // 剪贴板写入可被拒绝(窗口没有焦点、权限被拒),也可能没有剪贴板 API:说明没复制成,不静默、不留未处理的 rejection
          const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
          if (typeof clipboard?.writeText !== 'function') {
            onCopyFailed('clipboard unavailable');
            return;
          }
          const failed = (err: unknown) => onCopyFailed(err instanceof Error ? err.message : String(err));
          // 同步调用 writeText(仍在点击的用户激活之内),结果再接住
          try {
            Promise.resolve(clipboard.writeText(exactCommand)).catch(failed);
          } catch (err) {
            failed(err);
          }
        }}
      >
        Copy
      </button>
    </div>
  );
}

// 每行一个元素、没有虚拟化:超长 diff(几十万行)会卡死面板。只渲染前 MAX_DIFF_LINES 行并说明;
// 数据不裁剪,hunk 操作仍从完整 diff 提取补丁。
export const MAX_DIFF_LINES = 5000;

// v0.1.4 hotfix: unified diff inline renderer 替 side-by-side MergeView。
// 像 `git diff` 终端那样：+ 行绿底 / - 行红底 / @@ hunk 头蓝 / context 行普通。
// Side-by-side MergeView 留 v0.2 议题（用 @codemirror/merge 时 layout / hidden a-side 问题）。
function UnifiedDiffView({
  diff,
  onJumpLine,
  hunkActions,
  onHunkAction,
  writesBlocked = false,
}: {
  readonly diff: string;
  readonly onJumpLine?: (line: number) => void;
  readonly hunkActions?: readonly DrawerAction[];
  readonly onHunkAction?: (hunkLineIndex: number, action: DrawerAction) => void;
  readonly writesBlocked?: boolean;
}) {
  if (!diff.trim()) {
    return <div className="cgv-diff-empty">(no textual diff — file may be binary or identical)</div>;
  }

  const allLines = diff.split('\n');
  const lines = allLines.length > MAX_DIFF_LINES ? allLines.slice(0, MAX_DIFF_LINES) : allLines;
  const actions = hunkActions ?? [];
  // 解析当前文件新版行号（用于 jump-back banner）：从 @@ -a,b +c,d @@ 的 c 起算
  let currentNewLine = 0;
  const rows = lines.map((line, i) => {
    let cls = 'cgv-line cgv-line-ctx';
    let lineLabel: number | null = null;

    if (line.startsWith('+++') || line.startsWith('---')) {
      cls = 'cgv-line cgv-line-meta';
    } else if (line.startsWith('@@')) {
      cls = 'cgv-line cgv-line-hunk';
      const m = line.match(/\+(\d+)/);
      if (m && m[1]) currentNewLine = parseInt(m[1], 10) - 1;
    } else if (line.startsWith('+')) {
      cls = 'cgv-line cgv-line-add';
      currentNewLine += 1;
      lineLabel = currentNewLine;
    } else if (line.startsWith('-')) {
      cls = 'cgv-line cgv-line-del';
      // - 行不增 newline 计数；jump 用最近 + / context 行号
    } else if (line.startsWith(' ') || line === '') {
      cls = 'cgv-line cgv-line-ctx';
      currentNewLine += 1;
      lineLabel = currentNewLine;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      cls = 'cgv-line cgv-line-meta';
    }

    return (
      <div
        key={i}
        className={cls}
        onClick={lineLabel !== null && onJumpLine ? () => onJumpLine(lineLabel!) : undefined}
        title={lineLabel !== null && onJumpLine ? `Click to jump-back to line ${lineLabel}` : undefined}
      >
        <span className="cgv-line-num">{lineLabel ?? ''}</span>
        <span className="cgv-line-text">{line}</span>
        {line.startsWith('@@') && actions.length > 0 && onHunkAction ? (
          <div className="cgv-hunk-actions">
            {actions.map((action) => {
              const label =
                action === 'stage' ? 'Stage' : action === 'unstage' ? 'Unstage' : 'Discard';
              const className =
                action === 'discard'
                  ? 'cgv-hunk-stage-btn cgv-discard-btn'
                  : 'cgv-hunk-stage-btn';
              return (
                <button
                  key={action}
                  className={className}
                  type="button"
                  onClick={() => onHunkAction(i, action)}
                  aria-label={`${label} hunk at ${line}`}
                  disabled={writesBlocked}
                  title={
                    writesBlocked
                      ? COMMIT_IN_PROGRESS_TITLE
                      : action === 'discard'
                      ? 'Discard is destructive. Use git stash first if uncertain.'
                      : `${label} this hunk`
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  });

  return (
    <div className="cgv-unified-diff">
      {rows}
      {allLines.length > lines.length ? (
        <div className="cgv-truncated-note" role="note">
          {`Diff too large — showing the first ${lines.length.toLocaleString('en-US')} of ${allLines.length.toLocaleString('en-US')} lines. Use git diff in a terminal to see the rest.`}
        </div>
      ) : null}
    </div>
  );
}

export function DiffView({
  app,
  store,
  change,
  diff,
  mode = 'changed',
  scopeReady,
  drawer: externalDrawer,
  dispatchDrawer: externalDispatchDrawer,
  writesBlocked = false,
}: DiffViewProps) {
  const mountedRef = useRef(true);
  const closeTimerRef = useRef<number | null>(null);
  const [localDrawer, localDispatchDrawer] = useReducer(previewDrawerReducer, {
    kind: 'idle',
  } satisfies PreviewDrawerState);
  const isDrawerLifted = externalDrawer !== undefined && externalDispatchDrawer !== undefined;
  const drawer = externalDrawer ?? localDrawer;
  const dispatchDrawer = externalDispatchDrawer ?? localDispatchDrawer;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  // 定义在下面的提前返回之前:"Diff too large" 占位的 Copy 失败也用它
  const showError = (message: string) => {
    if (tryNotify(app, { kind: 'error', message: visibleText(message) })) return;
    store.getState().setBanner({
      kind: 'error',
      message,
      dismissable: true,
    });
  };

  if (!change) return <main className="cgv-diff-empty">Select a file</main>;
  if (!diff) return <main className="cgv-diff-empty">Loading diff…</main>;
  if (!diff.ok) {
    if (diff.reason === 'too-large') {
      return <TooLargePlaceholder exactCommand={diff.exactCommand} onCopyFailed={(reason) => showError(`Could not copy the command: ${reason}`)} />;
    }
    return <main className="cgv-diff-empty">{visibleText(diff.message ?? 'git diff failed')}</main>;
  }

  const onJumpLine = async (line: number) => {
    const editor = app?.editor;
    if (typeof editor?.openFile !== 'function') {
      store.getState().setBanner({
        kind: 'warn',
        message: 'SDK editor unavailable; please upgrade Continuo to >= 0.2.3',
        dismissable: true,
      });
      return;
    }

    const scopeState = await (scopeReady ?? Promise.resolve('error'));
    if (scopeState !== 'grant') return;

    const state = store.getState();
    const repoRoot = state.repoRoot;
    if (!repoRoot) {
      state.setBanner({
        kind: 'error',
        message: 'Repo root unknown',
        dismissable: true,
      });
      return;
    }

    const selectedPath = state.selected?.path ?? change.path;
    const absPath = joinRepoPath(repoRoot, selectedPath);
    if (absPath === null) {
      state.setBanner({
        kind: 'error',
        message: `Invalid path: ${selectedPath} (not inside this repository)`,
        dismissable: true,
      });
      return;
    }
    let result;
    try {
      result = await editor.openFile(absPath, { line });
    } catch (err) {
      store.getState().setBanner({
        kind: 'error',
        message: `Open failed: ${err instanceof Error ? err.message : String(err)}`,
        dismissable: true,
      });
      return;
    }

    if (result.ok && result.lineApplied) return;

    if (result.ok) {
      const reason = result.reason ?? 'no-line-arg';
      const messageByReason = {
        'no-line-arg': `Opened ${selectedPath}`,
        'milkdown-engine': `Opened ${selectedPath}; cannot jump to line in Markdown editor. Press Cmd+P then paste: ${selectedPath}:${line}`,
        'line-out-of-range': `Opened ${selectedPath}; line ${line} is beyond file end`,
        'tab-not-mounted': `Opened ${selectedPath}; editor not mounted within 500ms. Please click again`,
      } satisfies Record<string, string>;
      store.getState().setBanner({
        kind: 'info',
        message: messageByReason[reason],
        dismissable: true,
      });
      return;
    }

    const messageByCode = {
      INVALID_PATH: `Invalid path: ${selectedPath} (need absolute path)`,
      PERMISSION_DENIED: `Need 'fs' permission or path '${selectedPath}' not in granted scope`,
      FS_NOT_FOUND: `File not found: ${selectedPath}`,
      FS_NOT_FILE: `Not a regular file: ${selectedPath}`,
      FS_DENIED: `Cannot read file: ${selectedPath} (${result.message})`,
      FS_IO: `Read error: ${selectedPath} (${result.message})`,
      EXCEPTION: `Open failed: ${result.message}`,
    } satisfies Record<string, string>;
    store.getState().setBanner({
      kind: 'error',
      message: messageByCode[result.code],
      dismissable: true,
    });
  };


  const handleHunkAction = (hunkLineIndex: number, action: DrawerAction) => {
    if (!diff.ok) return;
    const patch = extractHunkPatchFromUnifiedDiff(
      change.path,
      diff.unifiedDiff,
      hunkLineIndex,
    );
    if (!patch) {
      showError('Unable to build patch for selected hunk');
      return;
    }
    dispatchDrawer({ type: 'open', action, filePath: change.path, patch });
  };

  const handleConfirm = async () => {
    if (drawer.kind !== 'previewing' && drawer.kind !== 'error') return;
    const { repoRoot, commitInFlight } = store.getState();
    if (!app || !repoRoot || commitInFlight) {
      // 提交在进行:确认按钮本是禁用的(兜底,见 GitViewerPanel 的 runFileAction)
      const message = !repoRoot ? 'Repo root unknown' : !app ? 'SDK shell unavailable' : COMMIT_IN_PROGRESS_MESSAGE;
      dispatchDrawer({ type: 'confirm' });
      if (!mountedRef.current) return;
      dispatchDrawer({ type: 'fail', error: message });
      showError(message);
      return;
    }

    dispatchDrawer({ type: 'confirm' });
    if (!drawer.patch) {
      const message = 'Patch unavailable';
      if (!mountedRef.current) return;
      dispatchDrawer({ type: 'fail', error: message });
      showError(message);
      return;
    }

    // 从确认到 git 命令与随后的 refresh 结束,Commit / Amend 不可用(git-store 的 writesInFlight)
    const endWrite = store.getState().beginWrite();
    try {
      const result =
        drawer.action === 'stage'
          ? await stageHunk(app, repoRoot, drawer.patch)
          : drawer.action === 'unstage'
            ? await unstageHunk(app, repoRoot, drawer.patch)
            : await discardHunk(app, repoRoot, drawer.patch);
      if (!mountedRef.current) return;

      if (result.ok) {
        dispatchDrawer({ type: 'succeed' });
        // v0.3.2 hot-fix: when the action removes the last file from the
        // current section, store.refresh sets selected=null → DiffView
        // unmounts → PreviewDrawer (rendered inside DiffView) disappears
        // before the user can see the 'success' state. Surface a toast so
        // the destructive action always has visible confirmation.
        // (Stage/unstage also benefit, less critical since they don't
        // destroy work.)
        if (drawer.action === 'discard') {
          // 宿主拒绝显示(插件被吊销)时不退回 banner——与没有通知 API 时一样,只是不提示;刷新照常进行
          tryNotify(app, { kind: 'info', message: visibleText(`Hunk discarded from ${drawer.filePath}`) });
        }
        await store.getState().refresh();
        if (!mountedRef.current) return;
        closeTimerRef.current = window.setTimeout(() => {
          if (mountedRef.current) dispatchDrawer({ type: 'dismiss' });
        }, 800);
        return;
      }

      const message = result.error || 'Hunk no longer applies; refresh';
      dispatchDrawer({ type: 'fail', error: message });
      showError(message);
    } catch (err) {
      // 宿主拒绝执行等:照常报告,不留未处理的 rejection
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      dispatchDrawer({ type: 'fail', error: message });
      showError(message);
    } finally {
      endWrite();
    }
  };

  // 全文视图(NewFileView)按**区**判断,不看合并后的 status(`AM` / `AD` 同时出现在两个区):
  // - Staged 区:index 一侧是新增(X === 'A')→ index 版本全文(见 diff-fetcher);
  // - Changes 区:只有未跟踪文件 → 工作树全文。`AM` 的 M、`AD` 的 D 走下面的 unified diff
  //   (`git diff -- <path>`:index → 工作树的增量,带 hunk 操作)。
  const wholeFile = mode === 'staged' ? change.statusX === 'A' : diff.isUntracked;
  if (wholeFile) {
    if (diff.withheld) {
      return <main className="cgv-diff-empty">{WITHHELD_NOTICE[diff.withheld]}</main>;
    }
    return (
      <main className="cgv-diff">
        <NewFileView
          content={diff.modified}
          truncated={diff.modifiedTruncated}
          timedOut={diff.modifiedTimedOut}
          symlink={diff.modifiedIsSymlink}
        />
      </main>
    );
  }

  // Tracked changes → unified diff renderer
  const section = mode === 'staged' ? 'staged' : 'changed';
  const canStage = canStageHunk(change, diff, section);
  const canUnstage = canUnstageHunk(change, diff, section);
  const canDiscard = canDiscardHunk(change, diff, section);
  const hunkActions: DrawerAction[] = [];
  if (canStage) hunkActions.push('stage');
  if (canUnstage) hunkActions.push('unstage');
  if (canDiscard) hunkActions.push('discard');

  return (
    <main className="cgv-diff">
      {hasUndecodableText(diff.unifiedDiff) ? (
        <div className="cgv-truncated-note" role="note">
          {NON_UTF8_HUNK_NOTE}
        </div>
      ) : null}
      <UnifiedDiffView
        diff={diff.unifiedDiff}
        onJumpLine={onJumpLine}
        hunkActions={hunkActions}
        onHunkAction={handleHunkAction}
        writesBlocked={writesBlocked}
      />
      {!isDrawerLifted ? (
        <PreviewDrawer
          state={drawer}
          onConfirm={handleConfirm}
          onCancel={() => dispatchDrawer({ type: 'cancel' })}
          confirmBlockedReason={writesBlocked ? COMMIT_IN_PROGRESS_TITLE : null}
        />
      ) : null}
    </main>
  );
}
