// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NON_UTF8_HUNK_NOTE } from '../../git/hunk-patch';
import { DiffView } from '../../panel/DiffView';
import { createGitStore } from '../../state/git-store';

afterEach(() => cleanup());

const diff = {
  ok: true as const,
  path: 'src/a.ts',
  original: 'old',
  modified: 'new',
  unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
  isUntracked: false,
};

describe('DiffView hunk actions', () => {
  it('T19 renders Stage and Discard together for Changed M hunks, in that order', () => {
    const store = createGitStore();
    store.setState({ repoRoot: '/repo' });

    render(
      <DiffView
        store={store}
        change={{ path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }}
        diff={diff}
      />,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Stage', 'Discard']);
    expect(screen.getByRole('button', { name: /Stage hunk at/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Discard hunk at/ })).toBeTruthy();
  });

  it('T20 renders Unstage only for staged-mode M hunks', () => {
    const store = createGitStore();
    store.setState({ repoRoot: '/repo' });

    render(
      <DiffView
        store={store}
        mode="staged"
        change={{ path: 'src/a.ts', status: 'M', statusX: 'M', statusY: 'M', kind: 'text' }}
        diff={diff}
      />,
    );

    expect(screen.getByRole('button', { name: /Unstage hunk at/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Discard hunk at/ })).toBeNull();
  });

  it('T21 renders Stage and Discard together for Changed MM hunks', () => {
    const store = createGitStore();
    store.setState({ repoRoot: '/repo' });

    render(
      <DiffView
        store={store}
        change={{ path: 'src/a.ts', status: 'M', statusX: 'M', statusY: 'M', kind: 'text' }}
        diff={diff}
      />,
    );

    expect(screen.getByRole('button', { name: /Stage hunk at/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Discard hunk at/ })).toBeTruthy();
  });

  it('T22 renders no hunk actions for untracked new-file view', () => {
    const store = createGitStore();
    store.setState({ repoRoot: '/repo' });

    render(
      <DiffView
        store={store}
        change={{ path: 'src/new.ts', status: 'U', statusX: '?', statusY: '?', kind: 'text' }}
        diff={{ ...diff, path: 'src/new.ts', original: '', unifiedDiff: '', isUntracked: true }}
      />,
    );

    expect(screen.queryByRole('button', { name: /hunk at/ })).toBeNull();
  });
  it('T23 a diff containing U+FFFD (bytes that were not valid UTF-8) shows no hunk action in either section and a note saying why; an ordinary diff shows no such note', () => {
    const store = createGitStore();
    store.setState({ repoRoot: '/repo' });
    const lossy = { ...diff, unifiedDiff: '@@ -1 +1 @@\n-old\n+caf\uFFFD\n' };

    const changed = render(
      <DiffView store={store} change={{ path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }} diff={lossy} />,
    );
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.getByRole('note').textContent).toBe(NON_UTF8_HUNK_NOTE);
    expect(NON_UTF8_HUNK_NOTE).toBe(
      'This file contains bytes that are not valid UTF-8 (shown as \uFFFD) or the replacement character itself. Hunk actions are not available because they would not write those bytes back unchanged. Use the file-level actions instead.',
    );
    expect(screen.getByText('+caf\uFFFD')).toBeTruthy();
    changed.unmount();

    const staged = render(
      <DiffView store={store} mode="staged" change={{ path: 'src/a.ts', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' }} diff={lossy} />,
    );
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.getByRole('note').textContent).toBe(NON_UTF8_HUNK_NOTE);
    staged.unmount();

    render(
      <DiffView store={store} change={{ path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }} diff={diff} />,
    );
    expect(screen.queryByRole('note')).toBeNull();
  });
});
