// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiffMode, DiffResult } from '../../git/diff-fetcher';
import type { FileChange } from '../../git/status-scanner';
import { DiffView } from '../../panel/DiffView';
import { createGitStore } from '../../state/git-store';

afterEach(() => cleanup());

type OkDiff = Extract<DiffResult, { ok: true }>;

function view(change: FileChange, mode: DiffMode, diff: Partial<OkDiff>) {
  const store = createGitStore();
  store.setState({ repoRoot: '/repo' });
  return render(
    <DiffView
      store={store}
      mode={mode}
      change={change}
      diff={{ ok: true, path: change.path, original: '', modified: '', unifiedDiff: '', isUntracked: false, ...diff }}
    />,
  );
}

const change = (x: FileChange['statusX'], y: FileChange['statusY'], status: FileChange['status']): FileChange => ({
  path: 'n.txt', status, statusX: x, statusY: y, kind: 'text',
});

const INCREMENT = 'diff --git a/n.txt b/n.txt\n--- a/n.txt\n+++ b/n.txt\n@@ -1 +1,2 @@\n staged\n+later\n';
const DELETION = 'diff --git a/n.txt b/n.txt\ndeleted file mode 100644\n--- a/n.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-staged\n';

describe('which view a row gets is decided per section', () => {
  it('V1 `AM` in Changes: the index → working-tree increment as a unified diff with Stage / Discard hunk buttons, not the whole working-tree file', () => {
    const { container } = view(change('A', 'M', 'A'), 'changed', { modified: 'staged\nlater\n', unifiedDiff: INCREMENT });
    expect(container.querySelector('.cgv-new-file')).toBeNull();
    expect(container.querySelector('.cgv-unified-diff')).not.toBeNull();
    expect([...container.querySelectorAll('.cgv-line-add .cgv-line-text')].map((e) => e.textContent)).toEqual(['+later']);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Stage', 'Discard']);
  });

  it('V2 `AM` in Staged: the whole staged file (index version), no hunk buttons', () => {
    const { container } = view(change('A', 'M', 'A'), 'staged', { modified: 'staged\n', unifiedDiff: 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+staged\n' });
    expect(container.querySelector('.cgv-new-file')!.textContent).toBe('staged\n');
    expect(container.querySelector('.cgv-unified-diff')).toBeNull();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('V3 `AD` in Changes: the working-tree deletion as a diff, never "(empty file)"; in Staged it is still the whole staged file', () => {
    const { container } = view(change('A', 'D', 'A'), 'changed', { modified: '', unifiedDiff: DELETION });
    expect(container.textContent).not.toContain('(empty file)');
    expect([...container.querySelectorAll('.cgv-line-del .cgv-line-text')].map((e) => e.textContent)).toEqual(['-staged']);
    cleanup();
    const staged = view(change('A', 'D', 'A'), 'staged', { modified: 'staged\n' });
    expect(staged.container.querySelector('.cgv-new-file')!.textContent).toBe('staged\n');
  });

  it('V4 a staged new symbolic link: labelled "Symbolic link → <target>", the target is not presented as file content', () => {
    const { container } = view({ ...change('A', ' ', 'A'), path: 'ln' }, 'staged', { path: 'ln', modified: '../outside/secret.txt', modifiedIsSymlink: true });
    expect(container.querySelector('.cgv-new-file')).toBeNull();
    expect(screen.getByRole('note').textContent).toBe('Symbolic link → ../outside/secret.txt');
    // 普通的新文件没有这条标注
    cleanup();
    view(change('A', ' ', 'A'), 'staged', { modified: '../outside/secret.txt' });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('V4b a staged symbolic link whose stored target was only partly read (over the size limit, or the read timed out) says so, like a file does; a link read in full has no such notice', () => {
    const ln = { ...change('A', ' ', 'A'), path: 'ln' };
    const notes = () => screen.getAllByRole('note').map((n) => n.textContent);
    view(ln, 'staged', { path: 'ln', modified: 'aaaa', modifiedIsSymlink: true, modifiedTruncated: true });
    expect(notes()).toEqual(['Symbolic link → aaaa', 'Link target too long — showing only the first 1 MB of it.']);
    cleanup();
    view(ln, 'staged', { path: 'ln', modified: 'aa', modifiedIsSymlink: true, modifiedTruncated: true, modifiedTimedOut: true });
    expect(notes()).toEqual(['Symbolic link → aa', 'Reading this link took too long — showing only the part of its target that was read.']);
    cleanup();
    view(ln, 'staged', { path: 'ln', modified: 'target', modifiedIsSymlink: true });
    expect(notes()).toEqual(['Symbolic link → target']);
  });

  it('V5 untracked rows keep the whole-file view; a staged-new row whose staged version was withheld shows the notice', () => {
    const untracked = view(change('?', '?', 'U'), 'changed', { modified: 'new\n', isUntracked: true });
    expect(untracked.container.querySelector('.cgv-new-file')!.textContent).toBe('new\n');
    cleanup();
    const gitlink = view(change('A', ' ', 'A'), 'staged', { withheld: 'no-staged-blob' });
    expect(gitlink.container.textContent).toBe('No staged file content to show (submodule entry or unresolved merge conflict)');
  });

  it('V6 rows that are not new on the side being shown get the unified diff: `MM` in both sections, intent-to-add (` A`), `M ` with an empty HEAD read, and `UA` (merged status A, index side not an addition)', () => {
    for (const [c, mode] of [
      [change('M', 'M', 'M'), 'changed'], [change('M', 'M', 'M'), 'staged'],
      [change(' ', 'A', 'A'), 'changed'], [change('M', ' ', 'M'), 'staged'],
      // 合并后的 status 是 A,但 index 一侧不是新增(`UA`:对方新增的未合并路径)
      [change('U', 'A', 'A'), 'staged'],
    ] as const) {
      const { container } = view(c, mode, { modified: 'x\n', unifiedDiff: INCREMENT });
      expect({ xy: `${c.statusX}${c.statusY}`, mode, whole: container.querySelector('.cgv-new-file') !== null, unified: container.querySelector('.cgv-unified-diff') !== null })
        .toEqual({ xy: `${c.statusX}${c.statusY}`, mode, whole: false, unified: true });
      cleanup();
    }
  });
});
