// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewDrawer } from '../../panel/PreviewDrawer';

afterEach(() => cleanup());

function renderDiscard(filePath = 'a.ts', patch = 'patch') {
  const onConfirm = vi.fn();
  const view = render(
    <PreviewDrawer
      state={{ kind: 'previewing', action: 'discard', filePath, patch }}
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
  );
  const input = screen.getByLabelText('Type "discard" to confirm:');
  const button = screen.getByRole('button', { name: 'Discard hunk' });
  return { ...view, input, button, onConfirm };
}

describe('PreviewDrawer discard typed-confirm gate', () => {
  it('T13 keeps the CTA disabled for empty, uppercase, and trailing-space input', () => {
    const { input, button } = renderDiscard();

    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'DISCARD' } });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'discard ' } });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('T14 enables the CTA only for exact lowercase discard', () => {
    const { input, button } = renderDiscard();

    fireEvent.change(input, { target: { value: 'discard' } });

    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('T15 resets typed-confirm when the action changes', () => {
    const { input, rerender } = renderDiscard();
    fireEvent.change(input, { target: { value: 'discard' } });

    rerender(
      <PreviewDrawer
        state={{ kind: 'previewing', action: 'stage', filePath: 'a.ts', patch: 'patch' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    rerender(
      <PreviewDrawer
        state={{ kind: 'previewing', action: 'discard', filePath: 'a.ts', patch: 'patch' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByRole('button', { name: 'Discard hunk' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('T16 resets typed-confirm when file path changes without unmounting', () => {
    const { input, rerender } = renderDiscard('a.ts', 'patch');
    fireEvent.change(input, { target: { value: 'discard' } });

    rerender(
      <PreviewDrawer
        state={{ kind: 'previewing', action: 'discard', filePath: 'b.ts', patch: 'patch' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByRole('button', { name: 'Discard hunk' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('T17 resets typed-confirm when patch changes without unmounting', () => {
    const { input, rerender } = renderDiscard('a.ts', 'patch-a');
    fireEvent.change(input, { target: { value: 'discard' } });

    rerender(
      <PreviewDrawer
        state={{ kind: 'previewing', action: 'discard', filePath: 'a.ts', patch: 'patch-b' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByRole('button', { name: 'Discard hunk' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('T18 blocks Enter while the discard CTA is disabled', () => {
    const { input, onConfirm } = renderDiscard();

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onConfirm).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Discard hunk' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
