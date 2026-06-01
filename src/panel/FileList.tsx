import type { StoreApi } from 'zustand/vanilla';
import type { FileChange } from '../git/status-scanner';
import {
  selectChanged,
  selectStaged,
  selectUntracked,
  type DiffMode,
  type GitViewerState,
} from '../state/git-store';

interface FileListProps {
  readonly store: StoreApi<GitViewerState>;
  readonly changes: readonly FileChange[];
}

const statusIcon: Record<FileChange['status'], string> = {
  M: '~',
  A: '+',
  D: '-',
  R: 'R',
  U: '?',
};

function rowLabel(change: FileChange): string {
  return change.oldPath ? `${change.oldPath} -> ${change.path}` : change.path;
}

function Section({
  title,
  items,
  store,
  mode,
}: {
  readonly title: string;
  readonly items: readonly FileChange[];
  readonly store: StoreApi<GitViewerState>;
  readonly mode: DiffMode;
}) {
  if (items.length === 0) return null;

  return (
    <details className="cgv-section" open>
      <summary>
        <span>{title}</span>
        <span className="cgv-count">{items.length}</span>
      </summary>
      <ul>
        {items.map((change) => (
          <li key={`${title}:${change.statusX}${change.statusY}:${change.path}`}>
            <button
              className="cgv-file-row"
              type="button"
              onClick={() => store.getState().selectFile(change.path, mode)}
            >
              <span className="cgv-status">{statusIcon[change.status]}</span>
              <span className="cgv-path">{rowLabel(change)}</span>
              {change.kind === 'binary' ? <span className="cgv-badge">BIN</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function FileList({ store, changes }: FileListProps) {
  const staged = selectStaged({ changes });
  const changed = selectChanged({ changes });
  const untracked = selectUntracked({ changes });
  return (
    <aside className="cgv-file-list">
      <Section title="Staged" items={staged} store={store} mode="staged" />
      <Section title="Changed" items={changed} store={store} mode="changed" />
      <Section title="Untracked" items={untracked} store={store} mode="changed" />
    </aside>
  );
}
