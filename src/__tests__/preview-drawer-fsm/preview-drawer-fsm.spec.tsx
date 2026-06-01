// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PreviewDrawer,
  previewDrawerReducer,
  type PreviewDrawerState,
} from '../../panel/PreviewDrawer';

afterEach(() => cleanup());

describe('PreviewDrawer FSM', () => {
  it('T22 transitions idle -> previewing -> applying -> success -> idle', () => {
    let state: PreviewDrawerState = { kind: 'idle' };
    state = previewDrawerReducer(state, { type: 'open', filePath: 'a.ts', patch: 'patch' });
    expect(state).toEqual({ kind: 'previewing', filePath: 'a.ts', patch: 'patch' });
    state = previewDrawerReducer(state, { type: 'confirm' });
    expect(state).toEqual({ kind: 'applying', filePath: 'a.ts', patch: 'patch' });
    state = previewDrawerReducer(state, { type: 'succeed' });
    expect(state).toEqual({ kind: 'success', filePath: 'a.ts' });
    state = previewDrawerReducer(state, { type: 'dismiss' });
    expect(state).toEqual({ kind: 'idle' });
  });

  it('T23 transitions applying -> error and cancel -> idle', () => {
    let state = previewDrawerReducer({ kind: 'idle' }, {
      type: 'open',
      filePath: 'a.ts',
      patch: 'patch',
    });
    state = previewDrawerReducer(previewDrawerReducer(state, { type: 'confirm' }), {
      type: 'fail',
      error: 'patch failed',
    });
    expect(state).toEqual({
      kind: 'error',
      filePath: 'a.ts',
      patch: 'patch',
      error: 'patch failed',
    });
    expect(previewDrawerReducer(state, { type: 'cancel' })).toEqual({ kind: 'idle' });
  });

  it('T24 renders patch preview and calls confirm/cancel handlers', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <PreviewDrawer
        state={{ kind: 'previewing', filePath: 'a.ts', patch: 'diff --git a/a.ts b/a.ts\n' }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText('diff --git a/a.ts b/a.ts')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stage hunk' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('T25 maps Escape to cancel while the drawer is open', () => {
    const onCancel = vi.fn();
    render(
      <PreviewDrawer
        state={{ kind: 'previewing', filePath: 'a.ts', patch: 'patch' }}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
