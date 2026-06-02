import type { StoreApi } from 'zustand/vanilla';
import { canDiscardFile } from '../git/can-discard-file';
import { canStageFile } from '../git/can-stage-file';
import type { SectionKind } from '../git/can-stage-hunk';
import { canUnstageFile } from '../git/can-unstage-file';
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
  readonly onStageFile?: (change: FileChange, section: SectionKind) => void;
  readonly onUnstageFile?: (change: FileChange, section: SectionKind) => void;
  readonly onDiscardFile?: (change: FileChange, section: SectionKind) => void;
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
  section,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
}: {
  readonly title: string;
  readonly items: readonly FileChange[];
  readonly store: StoreApi<GitViewerState>;
  readonly mode: DiffMode;
  readonly section: SectionKind;
  readonly onStageFile?: (change: FileChange, section: SectionKind) => void;
  readonly onUnstageFile?: (change: FileChange, section: SectionKind) => void;
  readonly onDiscardFile?: (change: FileChange, section: SectionKind) => void;
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
          <li
            key={`${title}:${change.statusX}${change.statusY}:${change.path}`}
            className="cgv-file-li"
          >
            <button
              className="cgv-file-row"
              type="button"
              onClick={() => store.getState().selectFile(change.path, mode)}
            >
              <span className="cgv-status">{statusIcon[change.status]}</span>
              <span className="cgv-path">{rowLabel(change)}</span>
              {change.kind === 'binary' ? <span className="cgv-badge">BIN</span> : null}
            </button>
            <div className="cgv-row-actions">
              {onStageFile && canStageFile(change, section) ? (
                <button
                  type="button"
                  className="cgv-row-action-btn cgv-stage-action"
                  title={`Stage file ${change.path}`}
                  aria-label={`Stage file ${change.path}`}
                  onClick={() => onStageFile(change, section)}
                >
                  ↑
                </button>
              ) : null}
              {onUnstageFile && canUnstageFile(change, section) ? (
                <button
                  type="button"
                  className="cgv-row-action-btn cgv-unstage-action"
                  title={`Unstage file ${change.path}`}
                  aria-label={`Unstage file ${change.path}`}
                  onClick={() => onUnstageFile(change, section)}
                >
                  ↓
                </button>
              ) : null}
              {onDiscardFile && canDiscardFile(change, section) ? (
                <button
                  type="button"
                  className="cgv-row-action-btn cgv-discard-btn"
                  title={`Discard file ${change.path} (destructive)`}
                  aria-label={`Discard file ${change.path}`}
                  onClick={() => onDiscardFile(change, section)}
                >
                  ×
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function FileList({
  store,
  changes,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
}: FileListProps) {
  const staged = selectStaged({ changes });
  const changed = selectChanged({ changes });
  const untracked = selectUntracked({ changes });
  return (
    <aside className="cgv-file-list">
      <Section
        title="Staged"
        items={staged}
        store={store}
        mode="staged"
        section="staged"
        onStageFile={onStageFile}
        onUnstageFile={onUnstageFile}
        onDiscardFile={onDiscardFile}
      />
      <Section
        title="Changed"
        items={changed}
        store={store}
        mode="changed"
        section="changed"
        onStageFile={onStageFile}
        onUnstageFile={onUnstageFile}
        onDiscardFile={onDiscardFile}
      />
      <Section
        title="Untracked"
        items={untracked}
        store={store}
        mode="changed"
        section="untracked"
        onStageFile={onStageFile}
        onUnstageFile={onUnstageFile}
        onDiscardFile={onDiscardFile}
      />
    </aside>
  );
}
