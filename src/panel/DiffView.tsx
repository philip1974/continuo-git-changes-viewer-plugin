import { useEffect, useReducer, useRef, type Dispatch } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { canDiscardHunk } from '../git/can-discard-hunk';
import { canStageHunk } from '../git/can-stage-hunk';
import { canUnstageHunk } from '../git/can-unstage-hunk';
import { MAX_FILE_BYTES, type DiffMode, type DiffResult } from '../git/diff-fetcher';
import { discardHunk } from '../git/discard-hunk';
import { extractHunkPatchFromUnifiedDiff } from '../git/hunk-patch';
import { joinRepoPath } from '../git/path-utils';
import { stageHunk } from '../git/stage-hunk';
import { unstageHunk } from '../git/unstage-hunk';
import type { CoPluginApp } from '../sdk/types';
import type { FileChange } from '../git/status-scanner';
import type { GitViewerState } from '../state/git-store';
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
}

function NewFileView({
  content,
  truncated,
  timedOut,
}: {
  readonly content: string;
  readonly truncated?: boolean;
  readonly timedOut?: boolean;
}) {
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
function TooLargePlaceholder({ exactCommand }: { readonly exactCommand: string | null }) {
  return (
    <div className="cgv-placeholder">
      <strong>Diff too large</strong>
      {exactCommand !== null ? <code>{exactCommand}</code> : null}
      <button
        type="button"
        disabled={exactCommand === null}
        title={
          exactCommand === null
            ? 'No command to copy: this file name contains control characters and cannot be pasted into a terminal safely'
            : undefined
        }
        onClick={() => {
          if (exactCommand !== null) void navigator.clipboard?.writeText(exactCommand);
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
}: {
  readonly diff: string;
  readonly onJumpLine?: (line: number) => void;
  readonly hunkActions?: readonly DrawerAction[];
  readonly onHunkAction?: (hunkLineIndex: number, action: DrawerAction) => void;
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
                  title={
                    action === 'discard'
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

  if (!change) return <main className="cgv-diff-empty">Select a file</main>;
  if (!diff) return <main className="cgv-diff-empty">Loading diff…</main>;
  if (!diff.ok) {
    if (diff.reason === 'too-large') {
      return <TooLargePlaceholder exactCommand={diff.exactCommand} />;
    }
    return <main className="cgv-diff-empty">{diff.message ?? 'git diff failed'}</main>;
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

  const showError = (message: string) => {
    if (typeof app?.notifications?.show === 'function') {
      app.notifications.show({ kind: 'error', message });
      return;
    }
    store.getState().setBanner({
      kind: 'error',
      message,
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
    const repoRoot = store.getState().repoRoot;
    if (!app || !repoRoot) {
      const message = !repoRoot ? 'Repo root unknown' : 'SDK shell unavailable';
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
      if (drawer.action === 'discard' && typeof app?.notifications?.show === 'function') {
        app.notifications.show({
          kind: 'info',
          message: `Hunk discarded from ${drawer.filePath}`,
        });
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
  };

  // Untracked / Added (HEAD 无版本) → NewFileView 显示 modified 全文(Staged 区是 index 版本,见 diff-fetcher)
  if (diff.isUntracked || (diff.original === '' && change.status === 'A')) {
    if (diff.withheld) {
      return <main className="cgv-diff-empty">{WITHHELD_NOTICE[diff.withheld]}</main>;
    }
    return (
      <main className="cgv-diff">
        <NewFileView content={diff.modified} truncated={diff.modifiedTruncated} timedOut={diff.modifiedTimedOut} />
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
      <UnifiedDiffView
        diff={diff.unifiedDiff}
        onJumpLine={onJumpLine}
        hunkActions={hunkActions}
        onHunkAction={handleHunkAction}
      />
      {!isDrawerLifted ? (
        <PreviewDrawer
          state={drawer}
          onConfirm={handleConfirm}
          onCancel={() => dispatchDrawer({ type: 'cancel' })}
        />
      ) : null}
    </main>
  );
}
