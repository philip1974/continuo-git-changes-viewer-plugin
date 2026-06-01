// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewDrawer } from '../../panel/PreviewDrawer';

afterEach(() => cleanup());

describe('PreviewDrawer action parameterization', () => {
  it('T20 renders stage labels and aria names', () => {
    render(
      <PreviewDrawer
        state={{ kind: 'previewing', action: 'stage', filePath: 'a.ts', patch: 'patch' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: 'Stage hunk preview' })).toBeTruthy();
    expect(screen.getByText('Stage hunk: a.ts')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stage hunk' })).toBeTruthy();
  });

  it('T21 renders unstage labels and aria names', () => {
    render(
      <PreviewDrawer
        state={{ kind: 'previewing', action: 'unstage', filePath: 'a.ts', patch: 'patch' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: 'Unstage hunk preview' })).toBeTruthy();
    expect(screen.getByText('Unstage hunk: a.ts')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unstage hunk' })).toBeTruthy();
  });

  it('T22 renders action-specific success text', () => {
    render(
      <PreviewDrawer
        state={{ kind: 'success', action: 'unstage', filePath: 'a.ts' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Hunk unstaged')).toBeTruthy();
  });
});
