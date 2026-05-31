import type { StoreApi } from 'zustand/vanilla';
import type { DiffResult } from '../git/diff-fetcher';
import type { FileChange } from '../git/status-scanner';
import type { GitViewerState } from '../state/git-store';
import { CodeMirrorMergeView } from '../diff/merge-view';

interface DiffViewProps {
  readonly store: StoreApi<GitViewerState>;
  readonly change: FileChange | null;
  readonly diff: DiffResult | null;
}

function modifiedFromUnified(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

function originalFromUnified(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---'))
    .map((line) => line.slice(1))
    .join('\n');
}

function NewFileView({ diff }: { readonly diff: string }) {
  return <pre className="cgv-new-file">{modifiedFromUnified(diff)}</pre>;
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

export function DiffView({ store, change, diff }: DiffViewProps) {
  if (!change) return <main className="cgv-diff-empty">Select a file</main>;
  if (!diff) return <main className="cgv-diff-empty">No diff loaded</main>;
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

  if (change.status === 'U') {
    return (
      <main className="cgv-diff">
        <button className="cgv-line-jump" type="button" onClick={() => setJumpBanner(1)}>
          1
        </button>
        <NewFileView diff={diff.diff} />
      </main>
    );
  }

  return (
    <main className="cgv-diff">
      <button className="cgv-line-jump" type="button" onClick={() => setJumpBanner(1)}>
        1
      </button>
      <CodeMirrorMergeView
        original={originalFromUnified(diff.diff)}
        modified={modifiedFromUnified(diff.diff)}
      />
    </main>
  );
}
