// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsTab } from '../../panel/SettingsTab';
import type { CoPluginApp } from '../../sdk/types';

function makeApp({
  readValue = null,
  writeReject = null,
}: {
  readonly readValue?: unknown;
  readonly writeReject?: Error | null;
} = {}): CoPluginApp {
  return {
    dataStore: {
      read: vi.fn(async () => readValue),
      write: vi.fn(async () => {
        if (writeReject) throw writeReject;
      }),
    },
    notifications: { show: vi.fn() },
  } as unknown as CoPluginApp;
}

afterEach(() => {
  cleanup();
});

describe('SettingsTab auto-refresh interval', () => {
  it('T14 renders four radio options inside an accessible fieldset', () => {
    const app = makeApp();

    render(<SettingsTab app={app} pluginId="git-viewer" />);

    expect(
      screen.getByRole('radiogroup', { name: 'Auto-refresh interval' }),
    ).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(screen.getByLabelText('Off')).toBeTruthy();
    expect(screen.getByLabelText('2 seconds')).toBeTruthy();
    expect(screen.getByLabelText('5 seconds (default)')).toBeTruthy();
    expect(screen.getByLabelText('10 seconds')).toBeTruthy();
  });

  it('T15 writes the blob and updates the UI optimistically', async () => {
    const app = makeApp({
      readValue: { autoRefresh: { intervalSec: 10 } },
    });

    render(<SettingsTab app={app} pluginId="git-viewer" />);

    await waitFor(() =>
      expect(screen.getByLabelText('10 seconds')).toHaveProperty('checked', true),
    );
    fireEvent.click(screen.getByLabelText('2 seconds'));

    expect(screen.getByLabelText('2 seconds')).toHaveProperty('checked', true);
    await waitFor(() =>
      expect(app.dataStore.write).toHaveBeenCalledWith('git-viewer', {
        autoRefresh: { intervalSec: 2 },
      }),
    );
  });

  it('T16 shows a warning notification when the write fails', async () => {
    const app = makeApp({ writeReject: new Error('disk full') });

    render(<SettingsTab app={app} pluginId="git-viewer" />);
    fireEvent.click(screen.getByLabelText('10 seconds'));

    await waitFor(() =>
      expect(app.notifications?.show).toHaveBeenCalledWith({
        kind: 'warning',
        message: 'Failed to save Auto-refresh setting',
      }),
    );
  });
});
