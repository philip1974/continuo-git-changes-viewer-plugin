import type { StoreApi } from 'zustand/vanilla';
import type { DiffResult } from '../git/diff-fetcher';
import { joinRepoPath } from '../git/path-utils';
import type { CoPluginApp } from '../sdk/types';
import type { FileChange } from '../git/status-scanner';
import type { GitViewerState } from '../state/git-store';

interface DiffViewProps {
  readonly app?: CoPluginApp;
  readonly store: StoreApi<GitViewerState>;
  readonly change: FileChange | null;
  readonly diff: DiffResult | null;
  readonly scopeReady?: Promise<'grant' | 'deny' | 'no-workspace' | 'error'>;
}

function NewFileView({ content }: { readonly content: string }) {
  return <pre className="cgv-new-file">{content || '(empty file)'}</pre>;
}

function TooLargePlaceholder({ exactCommand }: { readonly exactCommand: string }) {
  return (
    <div className="cgv-placeholder">
      <strong>Diff too large</strong>
      <code>{exactCommand}</code>
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(exactCommand)}
      >
        Copy
      </button>
    </div>
  );
}

// v0.1.4 hotfix: unified diff inline renderer 替 side-by-side MergeView。
// 像 `git diff` 终端那样：+ 行绿底 / - 行红底 / @@ hunk 头蓝 / context 行普通。
// Side-by-side MergeView 留 v0.2 议题（用 @codemirror/merge 时 layout / hidden a-side 问题）。
function UnifiedDiffView({
  diff,
  onJumpLine,
}: {
  readonly diff: string;
  readonly onJumpLine?: (line: number) => void;
}) {
  if (!diff.trim()) {
    return <div className="cgv-diff-empty">(no textual diff — file may be binary or identical)</div>;
  }

  const lines = diff.split('\n');
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
      </div>
    );
  });

  return <div className="cgv-unified-diff">{rows}</div>;
}

export function DiffView({ app, store, change, diff, scopeReady }: DiffViewProps) {
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

    const selectedPath = state.selectedPath ?? change.path;
    const absPath = joinRepoPath(repoRoot, selectedPath);
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

  // Untracked / Added (HEAD 无版本) → NewFileView 显示 modified 全文
  if (diff.isUntracked || (diff.original === '' && change.status === 'A')) {
    return (
      <main className="cgv-diff">
        <NewFileView content={diff.modified} />
      </main>
    );
  }

  // Tracked changes → unified diff renderer
  return (
    <main className="cgv-diff">
      <UnifiedDiffView diff={diff.unifiedDiff} onJumpLine={onJumpLine} />
    </main>
  );
}
