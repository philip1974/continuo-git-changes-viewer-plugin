// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitStore } from '../../state/git-store';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import { DiffView } from '../../panel/DiffView';
import type { CoPluginApp } from '../../sdk/types';

afterEach(() => {
  cleanup();
});

describe('GitViewerPanel', () => {
  it('T1 renders Changed and Untracked sections', async () => {
    // v0.1.1 panel mount auto-refresh → 必须经 deps.load 注入 changes
    // 否则 setState 被 mount-time refresh 覆盖为空
    const store = createGitStore({
      load: async () => ({
        repoRoot: '/repo',
        changes: [
          { path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
          { path: 'notes.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' },
        ],
      }),
    });

    render(<GitViewerPanel store={store} />);
    // 等 auto-refresh 完成
    await screen.findByText('Changed');

    expect(screen.getByText('Changed')).toBeTruthy();
    expect(screen.getByText('Untracked')).toBeTruthy();
    expect(screen.getByText('src/a.ts', { selector: '.cgv-path' })).toBeTruthy();
    expect(screen.getByText('notes.txt', { selector: '.cgv-path' })).toBeTruthy();
  });

  it('T2 clicking a + line opens the selected file at that line', async () => {
    const openFile = vi.fn(async () => ({ ok: true as const, lineApplied: true }));
    const app = { editor: { openFile } } as unknown as CoPluginApp;
    const store = createGitStore();
    store.setState({ repoRoot: '/repo' });

    render(
      <DiffView
        app={app}
        scopeReady={Promise.resolve('grant')}
        store={store}
        change={{ path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }}
        diff={{
          ok: true,
          path: 'src/a.ts',
          original: 'old\n',
          modified: 'new\n',
          unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
          isUntracked: false,
        }}
      />,
    );

    // unified diff 解析：@@ +1 起算；-old 不增计数；+new = line 1
    // 点 "+new" 行触发 jump-back
    const plusLine = screen.getByText(/\+new/);
    fireEvent.click(plusLine.closest('.cgv-line')!);

    await vi.waitFor(() => {
      expect(openFile).toHaveBeenCalledWith('/repo/src/a.ts', { line: 1 });
    });
    expect(store.getState().banner).toBeNull();
  });

  it('T3 renders too-large placeholder with exact command', () => {
    const store = createGitStore();

    render(
      <DiffView
        store={store}
        change={{ path: 'big.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }}
        diff={{
          ok: false,
          reason: 'too-large',
          path: 'big.txt',
          exactCommand: 'git diff -- big.txt',
        }}
      />,
    );

    expect(screen.getByText('Diff too large')).toBeTruthy();
    expect(screen.getByText('git diff -- big.txt')).toBeTruthy();
  });
});
