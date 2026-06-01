import { useEffect, useState } from 'react';
import type { CoPluginApp } from '../sdk/types';
import {
  AUTO_REFRESH_INTERVALS,
  type AutoRefreshIntervalSec,
  DEFAULT_AUTO_REFRESH_INTERVAL_SEC,
  readAutoRefreshIntervalSec,
  writeAutoRefreshIntervalSec,
} from '../lib/settings-store';

interface SettingsTabProps {
  readonly app: CoPluginApp;
  readonly pluginId: string;
}

function intervalLabel(sec: AutoRefreshIntervalSec): string {
  if (sec === 0) return 'Off';
  return `${sec} seconds${sec === DEFAULT_AUTO_REFRESH_INTERVAL_SEC ? ' (default)' : ''}`;
}

export function SettingsTab({ app, pluginId }: SettingsTabProps) {
  const [value, setValue] = useState<AutoRefreshIntervalSec>(
    DEFAULT_AUTO_REFRESH_INTERVAL_SEC,
  );

  useEffect(() => {
    let cancelled = false;
    void readAutoRefreshIntervalSec(app.dataStore, pluginId).then((stored) => {
      if (!cancelled) setValue(stored);
    });
    return () => {
      cancelled = true;
    };
  }, [app, pluginId]);

  const onChange = async (next: AutoRefreshIntervalSec): Promise<void> => {
    setValue(next);
    try {
      await writeAutoRefreshIntervalSec(app.dataStore, pluginId, next);
    } catch {
      app.notifications?.show({
        kind: 'warning',
        message: 'Failed to save Auto-refresh setting',
      });
    }
  };

  return (
    <fieldset
      className="cgv-settings"
      role="radiogroup"
      aria-labelledby="cgv-settings-legend"
    >
      <legend id="cgv-settings-legend" className="cgv-settings-legend">
        Auto-refresh interval
      </legend>
      <p className="cgv-settings-hint">
        Re-scan working tree at this interval while the panel is visible.
      </p>
      {AUTO_REFRESH_INTERVALS.map((sec) => (
        <label className="cgv-settings-radio" key={sec}>
          <input
            type="radio"
            name="cgv-auto-refresh-interval"
            value={sec}
            checked={value === sec}
            onChange={() => void onChange(sec)}
          />
          <span>{intervalLabel(sec)}</span>
        </label>
      ))}
      <p className="cgv-settings-hint">
        Changes apply when the panel becomes visible.
      </p>
    </fieldset>
  );
}
