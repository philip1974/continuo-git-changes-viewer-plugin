// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileList } from '../../panel/FileList';
import { createGitStore } from '../../state/git-store';
import type { FileChange } from '../../git/status-scanner';

afterEach(() => cleanup());

const changes: FileChange[] = [
  { path: 'staged.ts', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' },
  { path: 'changed.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
  { path: 'partial.ts', status: 'M', statusX: 'M', statusY: 'M', kind: 'text' },
  { path: 'notes.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' },
];

describe('FileList staged/changed/untracked sections', () => {
  it('T19 renders all non-empty sections and duplicates partial rows in Staged and Changed', () => {
    render(<FileList store={createGitStore()} changes={changes} />);

    expect(screen.getByText('Staged')).toBeTruthy();
    expect(screen.getByText('Changed')).toBeTruthy();
    expect(screen.getByText('Untracked')).toBeTruthy();
    expect(screen.getAllByText('partial.ts', { selector: '.cgv-path' })).toHaveLength(2);
  });

  it('T20 hides empty sections', () => {
    render(<FileList store={createGitStore()} changes={[changes[1]!]} />);

    expect(screen.queryByText('Staged')).toBeNull();
    expect(screen.getByText('Changed')).toBeTruthy();
    expect(screen.queryByText('Untracked')).toBeNull();
  });

  it('T21 allows staged and changed rows to select files with section modes', () => {
    const store = createGitStore();
    const selectFile = vi.spyOn(store.getState(), 'selectFile');

    render(<FileList store={store} changes={changes} />);

    fireEvent.click(screen.getByText('staged.ts', { selector: '.cgv-path' }).closest('button')!);
    fireEvent.click(screen.getByText('changed.ts', { selector: '.cgv-path' }).closest('button')!);

    expect(selectFile).toHaveBeenNthCalledWith(1, 'staged.ts', 'staged');
    expect(selectFile).toHaveBeenNthCalledWith(2, 'changed.ts', 'changed');
  });
});
