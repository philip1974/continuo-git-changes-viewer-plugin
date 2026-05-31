// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitStore } from '../../state/git-store';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import { DiffView } from '../../panel/DiffView';

afterEach(() => {
  cleanup();
});

describe('GitViewerPanel', () => {
  it('T1 renders Changed and Untracked sections', () => {
    const store = createGitStore();
    store.setState({
      changes: [
        { path: 'src/a.ts', status: 'M', kind: 'text' },
        { path: 'notes.txt', status: 'U', kind: 'text' },
      ],
      selectedPath: 'src/a.ts',
    });

    render(<GitViewerPanel store={store} />);

    expect(screen.getByText('Changed')).toBeTruthy();
    expect(screen.getByText('Untracked')).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('notes.txt')).toBeTruthy();
  });

  it('T2 clicking a hunk line sets the jump-back banner', () => {
    const store = createGitStore();

    render(
      <DiffView
        store={store}
        change={{ path: 'src/a.ts', status: 'M', kind: 'text' }}
        diff={{ ok: true, path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '1' }));

    expect(store.getState().banner?.message).toContain('src/a.ts:1');
    expect(store.getState().banner?.message).toContain('Jump-back coming in v0.2');
  });

  it('T3 renders too-large placeholder with exact command', () => {
    const store = createGitStore();

    render(
      <DiffView
        store={store}
        change={{ path: 'big.txt', status: 'M', kind: 'text' }}
        diff={{
          ok: false,
          reason: 'too-large',
          path: 'big.txt',
          exactCommand: 'git diff HEAD -- big.txt',
        }}
      />,
    );

    expect(screen.getByText('Diff too large')).toBeTruthy();
    expect(screen.getByText('git diff HEAD -- big.txt')).toBeTruthy();
  });
});
