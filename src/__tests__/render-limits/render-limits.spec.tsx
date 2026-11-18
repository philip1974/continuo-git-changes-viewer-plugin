// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanStatus, type FileChange } from '../../git/status-scanner';
import { DiffView, MAX_DIFF_LINES } from '../../panel/DiffView';
import { FileList, MAX_SECTION_ROWS } from '../../panel/FileList';
import type { PreviewDrawerAction } from '../../panel/PreviewDrawer';
import { createGitStore } from '../../state/git-store';
import type { CoPluginApp } from '../../sdk/types';

afterEach(() => cleanup());

const change: FileChange = { path: 'big.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' };

// 头 4 行 + 每个 hunk(1 行头 + linesPerHunk 行 `+`),不带结尾换行
function bigDiff(hunks: number, linesPerHunk: number): string {
  const out = ['diff --git a/big.txt b/big.txt', 'index 1111111..2222222 100644', '--- a/big.txt', '+++ b/big.txt'];
  for (let h = 0; h < hunks; h++) {
    out.push(`@@ -${h * 10 + 1},0 +${h * 10 + 1},${linesPerHunk} @@`);
    for (let l = 0; l < linesPerHunk; l++) out.push(`+h${h}l${l}`);
  }
  return out.join('\n');
}

function renderDiff(unifiedDiff: string, dispatchDrawer?: (a: PreviewDrawerAction) => void) {
  return render(
    <DiffView
      store={createGitStore()}
      change={change}
      diff={{ ok: true, path: 'big.txt', original: 'x', modified: 'y', unifiedDiff, isUntracked: false }}
      drawer={dispatchDrawer ? { kind: 'idle' } : undefined}
      dispatchDrawer={dispatchDrawer}
    />,
  );
}

describe('diff rendering is capped', () => {
  it('L1 a diff over the limit renders the first MAX_DIFF_LINES lines plus a notice with the total', () => {
    expect(MAX_DIFF_LINES).toBe(5000);
    const diff = bigDiff(3, 3000); // 4 + 3 * 3001 = 9007 行
    const { container } = renderDiff(diff);

    expect(container.querySelectorAll('.cgv-line')).toHaveLength(MAX_DIFF_LINES);
    expect(screen.getByText('+h0l0')).toBeTruthy();
    expect(screen.queryByText('+h2l2999')).toBeNull();
    expect(screen.getByRole('note').textContent).toBe(
      'Diff too large — showing the first 5,000 of 9,007 lines. Use git diff in a terminal to see the rest.',
    );
  });

  it('L2 a diff at the limit renders completely without a notice', () => {
    const diff = bigDiff(1, MAX_DIFF_LINES - 5); // 恰好 5000 行
    expect(diff.split('\n')).toHaveLength(MAX_DIFF_LINES);
    const { container } = renderDiff(diff);

    expect(container.querySelectorAll('.cgv-line')).toHaveLength(MAX_DIFF_LINES);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('L3 a hunk that crosses the cut is still extracted whole from the full diff', () => {
    const dispatch = vi.fn();
    renderDiff(bigDiff(3, 3000), dispatch);

    // 第二个 hunk 的头在第 3005 行(已渲染),它的 3000 行内容跨过第 5000 行
    fireEvent.click(screen.getByRole('button', { name: 'Stage hunk at @@ -11,0 +11,3000 @@' }));

    const action = dispatch.mock.calls[0]![0] as Extract<PreviewDrawerAction, { type: 'open' }>;
    expect(action.type).toBe('open');
    const patchLines = (action.patch ?? '').split('\n');
    expect(patchLines.filter((l) => l.startsWith('+h1l'))).toHaveLength(3000);
    expect(patchLines.some((l) => l.startsWith('+h2l') || l.startsWith('+h0l'))).toBe(false);
  });
});

describe('file list rendering is capped', () => {
  const many = (n: number, x: FileChange['statusX'], y: FileChange['statusY']): FileChange[] =>
    Array.from({ length: n }, (_, i) => ({ path: `f${i}.txt`, status: x === '?' ? 'U' : 'M', statusX: x, statusY: y, kind: 'text' }));

  it('L4 a section over the limit renders MAX_SECTION_ROWS rows and a notice; the count shows the real total', () => {
    expect(MAX_SECTION_ROWS).toBe(2000);
    const { container } = render(<FileList store={createGitStore()} changes={many(MAX_SECTION_ROWS + 500, '?', '?')} />);

    expect(container.querySelectorAll('.cgv-file-li')).toHaveLength(MAX_SECTION_ROWS);
    expect(container.querySelector('.cgv-count')!.textContent).toBe('2500');
    expect(screen.getByRole('note').textContent).toBe(
      'Showing the first 2,000 of 2,500 files. Use git status in a terminal to see the rest.',
    );
  });

  it('L5 sections at or below the limit render completely without a notice (each section is capped on its own)', () => {
    const changes = [...many(MAX_SECTION_ROWS, ' ', 'M'), ...many(3, '?', '?').map((c) => ({ ...c, path: `u-${c.path}` }))];
    const { container } = render(<FileList store={createGitStore()} changes={changes} />);

    expect(container.querySelectorAll('.cgv-file-li')).toHaveLength(MAX_SECTION_ROWS + 3);
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('status output truncated by the host output limit', () => {
  it('L6 only complete records are parsed: the cut-off tail never becomes an entry', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: ' M a.txt\0?? b.txt\0 M very/long/pa', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: true })
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false });
    const app = { shell: { exec } } as unknown as CoPluginApp;

    expect((await scanStatus(app, '/repo')).map((c) => c.path)).toEqual(['a.txt', 'b.txt']);
  });
});
