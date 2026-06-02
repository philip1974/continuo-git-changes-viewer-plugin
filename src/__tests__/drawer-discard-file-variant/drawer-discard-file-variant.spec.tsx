// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewDrawer } from '../../panel/PreviewDrawer';

afterEach(() => cleanup());

describe('PreviewDrawer discard-file variant', () => {
  it('T29 renders warning and typed-confirm for discard-file', () => {
    render(
      <PreviewDrawer
        state={{ kind: 'previewing', action: 'discard-file', filePath: 'a.ts', body: 'File: a.ts' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const drawer = screen.getByRole('region', { name: 'Discard file preview' });
    expect(within(drawer).getByText(/WARNING: This will permanently delete/)).toBeTruthy();
    expect(within(drawer).getByLabelText('Type "discard" to confirm:')).toBeTruthy();
    expect((within(drawer).getByRole('button', { name: 'Discard file' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('T30 uses file-specific labels and exact typed-confirm', () => {
    const onConfirm = vi.fn();
    render(
      <PreviewDrawer
        state={{ kind: 'previewing', action: 'discard-file', filePath: 'a.ts', body: 'File: a.ts' }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByLabelText('Type "discard" to confirm:');
    fireEvent.change(input, { target: { value: 'DISCARD' } });
    expect((screen.getByRole('button', { name: 'Discard file' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'discard' } });
    const button = screen.getByRole('button', { name: 'Discard file' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('T31 renders body field instead of requiring a patch', () => {
    const { rerender } = render(
      <PreviewDrawer
        state={{ kind: 'previewing', action: 'discard-file', filePath: 'a.ts', body: 'File: a.ts (X=  Y=M)' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText((text) => /^File: a\.ts \(X=\s+Y=M\)$/.test(text))).toBeTruthy();
    expect(screen.queryByText(/diff --git/)).toBeNull();

    rerender(
      <PreviewDrawer
        state={{ kind: 'success', action: 'discard-file', filePath: 'a.ts' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('File discarded')).toBeTruthy();
  });
});
