// @vitest-environment jsdom
// `git rm --cached f.txt` 之后同一路径有两行(Staged 的 `D  f.txt` 与 Untracked 的 `?? f.txt`):
// 面板上两行各自可选,各显示自己那条记录的内容。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffMode, DiffResult } from '../../git/diff-fetcher';
import type { FileChange } from '../../git/status-scanner';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import { createGitStore } from '../../state/git-store';

afterEach(() => cleanup());

const stagedDeletion: FileChange = { path: 'f.txt', status: 'D', statusX: 'D', statusY: ' ', kind: 'text' };
const untracked: FileChange = { path: 'f.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' };
const DELETION = 'diff --git a/f.txt b/f.txt\ndeleted file mode 100644\n--- a/f.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-committed line\n';

function renderPanel() {
  const fetchDiff = vi.fn(async (_root: string, change: FileChange, _mode: DiffMode): Promise<DiffResult> =>
    change.statusX === '?'
      ? { ok: true, path: change.path, original: '', modified: 'still on disk\n', unifiedDiff: '', isUntracked: true }
      : { ok: true, path: change.path, original: 'committed line\n', modified: '', unifiedDiff: DELETION, isUntracked: false });
  const store = createGitStore({ fetchDiff, load: async () => ({ repoRoot: '/repo', changes: [stagedDeletion, untracked] }) });
  const utils = render(<GitViewerPanel store={store} />);
  const row = (section: string) =>
    [...utils.container.querySelectorAll('details.cgv-section')]
      .find((d) => d.querySelector('summary span')!.textContent === section)!
      .querySelector('button.cgv-file-row') as HTMLButtonElement;
  return { ...utils, store, fetchDiff, row };
}

describe('two rows for one path are selected and shown independently', () => {
  it('P1 the Untracked row shows the working-tree file, the Staged row shows the staged deletion; switching back and forth and refreshing keeps each on its own record', async () => {
    const { container, store, fetchDiff, row } = renderPanel();
    await waitFor(() => expect(screen.getByText('Untracked')).toBeTruthy());

    fireEvent.click(row('Untracked'));
    await waitFor(() => expect(container.querySelector('.cgv-new-file')?.textContent).toBe('still on disk\n'));
    expect(store.getState().selected).toEqual({ path: 'f.txt', mode: 'changed' });
    expect(container.textContent).not.toContain('no textual diff');

    fireEvent.click(row('Staged'));
    await waitFor(() => expect(container.querySelector('.cgv-line-del .cgv-line-text')?.textContent).toBe('-committed line'));
    expect(container.querySelector('.cgv-new-file')).toBeNull();

    fireEvent.click(row('Untracked'));
    await waitFor(() => expect(container.querySelector('.cgv-new-file')?.textContent).toBe('still on disk\n'));

    // 刷新后选中的仍是 Untracked 那一行,内容仍是它的
    await store.getState().refresh();
    await waitFor(() => expect(container.querySelector('.cgv-new-file')?.textContent).toBe('still on disk\n'));
    expect(store.getState().selected).toEqual({ path: 'f.txt', mode: 'changed' });

    // 每次取 diff 传的都是该区自己的记录
    for (const [, change, mode] of fetchDiff.mock.calls) {
      expect(change).toBe(mode === 'staged' ? stagedDeletion : untracked);
    }
    expect(fetchDiff.mock.calls.some(([, , mode]) => mode === 'staged')).toBe(true);
    expect(fetchDiff.mock.calls.some(([, , mode]) => mode === 'changed')).toBe(true);
  });
});
