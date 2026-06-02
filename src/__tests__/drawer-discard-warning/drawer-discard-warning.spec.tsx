// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewDrawer } from '../../panel/PreviewDrawer';

afterEach(() => cleanup());

describe('PreviewDrawer discard warning UI', () => {
  it('T10 renders warning copy and typed-confirm input while previewing discard', () => {
    render(
      <PreviewDrawer
        state={{ kind: 'previewing', action: 'discard', filePath: 'a.ts', patch: 'patch' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const drawer = screen.getByRole('region', { name: 'Discard hunk preview' });
    expect(within(drawer).getByText(/WARNING: This will permanently delete the unstaged change/)).toBeTruthy();
    expect(within(drawer).getByLabelText('Type "discard" to confirm:')).toBeTruthy();
    expect((within(drawer).getByRole('button', { name: 'Discard hunk' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('T11 renders the same warning gate from discard error state', () => {
    render(
      <PreviewDrawer
        state={{
          kind: 'error',
          action: 'discard',
          filePath: 'a.ts',
          patch: 'patch',
          error: 'patch failed',
        }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const drawer = screen.getByRole('region', { name: 'Discard hunk preview' });
    expect(within(drawer).getByText(/WARNING: This will permanently delete the unstaged change/)).toBeTruthy();
    expect(within(drawer).getByText('patch failed')).toBeTruthy();
    expect((within(drawer).getByRole('button', { name: 'Retry discard hunk' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('T12 leaves stage and unstage preview UI without discard warning input', () => {
    const { rerender } = render(
      <PreviewDrawer
        state={{ kind: 'previewing', action: 'stage', filePath: 'a.ts', patch: 'patch' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: 'Stage hunk preview' })).toBeTruthy();
    expect(screen.queryByLabelText('Type "discard" to confirm:')).toBeNull();
    expect(screen.queryByText(/WARNING:/)).toBeNull();

    rerender(
      <PreviewDrawer
        state={{ kind: 'previewing', action: 'unstage', filePath: 'a.ts', patch: 'patch' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: 'Unstage hunk preview' })).toBeTruthy();
    expect(screen.queryByLabelText('Type "discard" to confirm:')).toBeNull();
    expect(screen.queryByText(/WARNING:/)).toBeNull();
  });

  it('T13 renders discard-specific success text without confirm controls', () => {
    render(
      <PreviewDrawer
        state={{ kind: 'success', action: 'discard', filePath: 'a.ts' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Hunk discarded')).toBeTruthy();
    expect(screen.queryByLabelText('Type "discard" to confirm:')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });
});
