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
  { path: 'notes.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' },
];

describe('FileList section-bound mode clicks', () => {
  it('T8 clicks Staged rows with mode=staged', () => {
    const store = createGitStore();
    const selectFile = vi.spyOn(store.getState(), 'selectFile');

    render(<FileList store={store} changes={changes} />);
    fireEvent.click(screen.getByText('staged.ts', { selector: '.cgv-path' }).closest('button')!);

    expect(selectFile).toHaveBeenCalledWith('staged.ts', 'staged');
  });

  it('T9 clicks Changed rows with mode=changed', () => {
    const store = createGitStore();
    const selectFile = vi.spyOn(store.getState(), 'selectFile');

    render(<FileList store={store} changes={changes} />);
    fireEvent.click(screen.getByText('changed.ts', { selector: '.cgv-path' }).closest('button')!);

    expect(selectFile).toHaveBeenCalledWith('changed.ts', 'changed');
  });

  it('T10 clicks Untracked rows with mode=changed', () => {
    const store = createGitStore();
    const selectFile = vi.spyOn(store.getState(), 'selectFile');

    render(<FileList store={store} changes={changes} />);
    fireEvent.click(screen.getByText('notes.txt', { selector: '.cgv-path' }).closest('button')!);

    expect(selectFile).toHaveBeenCalledWith('notes.txt', 'changed');
  });
});
