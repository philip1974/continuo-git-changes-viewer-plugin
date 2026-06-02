// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileList } from '../../panel/FileList';
import { createGitStore } from '../../state/git-store';
import type { FileChange } from '../../git/status-scanner';

afterEach(() => cleanup());

const changes: FileChange[] = [
  { path: 'staged.ts', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' },
  { path: 'changed.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
  { path: 'deleted.ts', status: 'D', statusX: ' ', statusY: 'D', kind: 'text' },
  { path: 'renamed.ts', status: 'R', statusX: 'R', statusY: ' ', kind: 'text' },
  { path: 'notes.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' },
];

function renderList(overrides: Partial<React.ComponentProps<typeof FileList>> = {}) {
  const onStageFile = vi.fn();
  const onUnstageFile = vi.fn();
  const onDiscardFile = vi.fn();
  const store = createGitStore();
  const selectFile = vi.spyOn(store.getState(), 'selectFile');
  render(
    <FileList
      store={store}
      changes={changes}
      onStageFile={onStageFile}
      onUnstageFile={onUnstageFile}
      onDiscardFile={onDiscardFile}
      {...overrides}
    />,
  );
  return { onStageFile, onUnstageFile, onDiscardFile, selectFile };
}

describe('FileList row action buttons', () => {
  it('T21 renders non-nested row markup with selection and actions as siblings', () => {
    renderList();

    const item = screen.getByText('changed.ts', { selector: '.cgv-path' }).closest('li')!;
    expect(item.className).toContain('cgv-file-li');
    expect(item.querySelector(':scope > button.cgv-file-row')).toBeTruthy();
    expect(item.querySelector(':scope > .cgv-row-actions')).toBeTruthy();
    expect(item.querySelector('button.cgv-file-row button')).toBeNull();
  });

  it('T22 and T23 CSS keeps hover and focus-within row actions visible without display none', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/index.css'), 'utf8');

    expect(css).toContain('.cgv-file-li:hover .cgv-row-actions');
    expect(css).toContain('.cgv-file-li:focus-within .cgv-row-actions');
    expect(css).not.toMatch(/\.cgv-row-actions\s*\{[^}]*display:\s*none/s);
  });

  it('T24 action click does not trigger row selection', () => {
    const { onStageFile, selectFile } = renderList();

    fireEvent.click(screen.getByRole('button', { name: 'Stage file changed.ts' }));

    expect(onStageFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'changed.ts' }), 'changed');
    expect(selectFile).not.toHaveBeenCalled();
  });

  it('T25 untracked rows show Stage only', () => {
    renderList();
    const item = screen.getByText('notes.txt', { selector: '.cgv-path' }).closest('li')!;

    expect(item.querySelector('[aria-label="Stage file notes.txt"]')).toBeTruthy();
    expect(item.querySelector('[aria-label="Discard file notes.txt"]')).toBeNull();
    expect(item.querySelector('[aria-label="Unstage file notes.txt"]')).toBeNull();
  });

  it('T26 changed M/D rows show Stage and Discard', () => {
    renderList();

    expect(screen.getByRole('button', { name: 'Stage file changed.ts' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard file changed.ts' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stage file deleted.ts' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard file deleted.ts' })).toBeTruthy();
  });

  it('T27 staged rows show Unstage only', () => {
    renderList();
    const item = screen.getByText('staged.ts', { selector: '.cgv-path' }).closest('li')!;

    expect(item.querySelector('[aria-label="Unstage file staged.ts"]')).toBeTruthy();
    expect(item.querySelector('[aria-label="Stage file staged.ts"]')).toBeNull();
    expect(item.querySelector('[aria-label="Discard file staged.ts"]')).toBeNull();
  });

  it('T28 R rows show no file-level action buttons in v0.3.4', () => {
    renderList();
    const item = screen.getByText('renamed.ts', { selector: '.cgv-path' }).closest('li')!;

    expect(item.querySelector('.cgv-row-action-btn')).toBeNull();
  });
});
