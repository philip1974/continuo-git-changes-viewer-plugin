// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsBus } from '../../lib/settings-bus';
import { SettingsTab } from '../../panel/SettingsTab';
import type { CoPluginApp } from '../../sdk/types';

function makeApp({
  readValue = { autoRefresh: { intervalSec: 5 } },
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

describe('SettingsTab bus emission', () => {
  it('T6 emits after a successful settings write', async () => {
    const app = makeApp();
    const bus = new SettingsBus();
    const emit = vi.spyOn(bus, 'emit');

    render(<SettingsTab app={app} pluginId="git-viewer" bus={bus} />);
    fireEvent.click(screen.getByLabelText('2 seconds'));

    await waitFor(() =>
      expect(app.dataStore.write).toHaveBeenCalledWith('git-viewer', {
        autoRefresh: { intervalSec: 2 },
      }),
    );
    expect(emit).toHaveBeenCalledWith(2);
  });

  it('T6.5 updates the selected radio when another settings tab emits', async () => {
    const app = makeApp();
    const bus = new SettingsBus();

    render(<SettingsTab app={app} pluginId="git-viewer" bus={bus} />);
    await waitFor(() =>
      expect(screen.getByLabelText('5 seconds (default)')).toHaveProperty(
        'checked',
        true,
      ),
    );

    bus.emit(10);

    await waitFor(() =>
      expect(screen.getByLabelText('10 seconds')).toHaveProperty('checked', true),
    );
  });

  it('T7 rolls back and does not emit when the settings write fails', async () => {
    const app = makeApp({ writeReject: new Error('store unavailable') });
    const bus = new SettingsBus();
    const emit = vi.spyOn(bus, 'emit');

    render(<SettingsTab app={app} pluginId="git-viewer" bus={bus} />);
    await waitFor(() =>
      expect(screen.getByLabelText('5 seconds (default)')).toHaveProperty(
        'checked',
        true,
      ),
    );
    fireEvent.click(screen.getByLabelText('Off'));

    await waitFor(() =>
      expect(app.notifications?.show).toHaveBeenCalledWith({
        kind: 'warning',
        message: 'Failed to save Auto-refresh setting',
      }),
    );
    expect(emit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('5 seconds (default)')).toHaveProperty(
      'checked',
      true,
    );
  });
});
