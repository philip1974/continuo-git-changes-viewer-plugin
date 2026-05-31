import type { StoreApi } from 'zustand/vanilla';
import type { DiffResult } from '../git/diff-fetcher';
import type { FileChange } from '../git/status-scanner';
import type { GitViewerState } from '../state/git-store';

interface DiffViewProps {
  readonly store: StoreApi<GitViewerState>;
  readonly change: FileChange | null;
  readonly diff: DiffResult | null;
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

export function DiffView({ store, change, diff }: DiffViewProps) {
  if (!change) return <main className="cgv-diff-empty">Select a file</main>;
  if (!diff) return <main className="cgv-diff-empty">Loading diff…</main>;
  if (!diff.ok) {
    if (diff.reason === 'too-large') {
      return <TooLargePlaceholder exactCommand={diff.exactCommand} />;
    }
    return <main className="cgv-diff-empty">{diff.message ?? 'git diff failed'}</main>;
  }

  const setJumpBanner = (line: number) => {
    store.getState().setBanner({
      kind: 'info',
      message: `Jump-back coming in v0.2. Press Cmd+P then paste: ${change.path}:${line}`,
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
      <UnifiedDiffView diff={diff.unifiedDiff} onJumpLine={setJumpBanner} />
    </main>
  );
}
