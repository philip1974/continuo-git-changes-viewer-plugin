import type { StoreApi } from 'zustand/vanilla';
import { canDiscardFile } from '../git/can-discard-file';
import { canStageFile } from '../git/can-stage-file';
import type { SectionKind } from '../git/can-stage-hunk';
import { canUnstageFile } from '../git/can-unstage-file';
import { isUnmerged, type FileChange } from '../git/status-scanner';
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

// 每个文件一行、没有虚拟化:status 条目极多(几万个未跟踪文件)时只渲染每段的前 MAX_SECTION_ROWS 行并说明;
// 数据不裁剪(计数、已暂存数量、提交都按完整列表)。
export const MAX_SECTION_ROWS = 2000;

const statusIcon: Record<FileChange['status'], string> = {
  M: '~',
  A: '+',
  D: '-',
  R: 'R',
  U: '?',
};

// 不可操作行(FileChange.inoperable):文件名是 POSIX 上合法、但插件不肯传给 git 的形式(`c:notes.txt`、`..\x`)。
// 只显示——路径是纯文本,行不是按钮,没有任何操作;已暂存的要说明"提交会包含它"(用户必须能看见将要提交什么)。
export const INOPERABLE_NOTE =
  'Unsupported file name — cannot be viewed or changed here. Use git in a terminal.';
export const INOPERABLE_STAGED_NOTE =
  'Unsupported file name — cannot be viewed or changed here, but it is staged and a commit will include it. Use git in a terminal.';

// 未合并的行(冲突):没有 Unstage / Discard(见 can-unstage-file / can-discard-file)。行上的标记说明原因。
export const UNMERGED_NOTE =
  'Unresolved merge conflict. Unstage and Discard are not available for it here: resolve the conflict in an editor or a terminal, then stage the result.';

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
  const rows = items.length > MAX_SECTION_ROWS ? items.slice(0, MAX_SECTION_ROWS) : items;

  return (
    <details className="cgv-section" open>
      <summary>
        <span>{title}</span>
        <span className="cgv-count">{items.length}</span>
      </summary>
      <ul>
        {rows.map((change, index) => (
          <li
            // 不可操作行的名字可能是解码之后才相同(两个不同的非 UTF-8 字节序列都变成 U+FFFD):加上行序号消歧。
            // 这些行没有状态、不可操作,按位置复用无妨;可操作行的路径在一个区里唯一,key 保持稳定。
            key={`${title}:${change.statusX}${change.statusY}:${change.path}${change.inoperable ? `#${index}` : ''}`}
            className="cgv-file-li"
          >
            {change.inoperable ? (
              <div className="cgv-file-row cgv-file-row--readonly">
                <span className="cgv-status">{statusIcon[change.status]}</span>
                <span className="cgv-path">{rowLabel(change)}</span>
                <span className="cgv-row-note" role="note">
                  {section === 'staged' ? INOPERABLE_STAGED_NOTE : INOPERABLE_NOTE}
                </span>
              </div>
            ) : (
              <button
                className="cgv-file-row"
                type="button"
                onClick={() => store.getState().selectFile(change.path, mode)}
              >
                <span className="cgv-status">{statusIcon[change.status]}</span>
                <span className="cgv-path">{rowLabel(change)}</span>
                {change.kind === 'binary' ? <span className="cgv-badge">BIN</span> : null}
                {isUnmerged(change) ? (
                  <span className="cgv-badge cgv-conflict-badge" title={UNMERGED_NOTE}>
                    CONFLICT
                  </span>
                ) : null}
              </button>
            )}
            <div className="cgv-row-actions">
              {onStageFile && canStageFile(change, section) ? (
                <button
                  type="button"
                  className="cgv-row-action-btn cgv-stage-action"
                  // 未合并的行上 `git add` 的含义是"标记为已解决"
                  title={isUnmerged(change) ? `Mark ${change.path} as resolved (git add)` : `Stage file ${change.path}`}
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
      {items.length > rows.length ? (
        <div className="cgv-truncated-note" role="note">
          {`Showing the first ${rows.length.toLocaleString('en-US')} of ${items.length.toLocaleString('en-US')} files. Use git status in a terminal to see the rest.`}
        </div>
      ) : null}
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
