import type { Disposable } from '../sdk/types';
import type { AutoRefreshIntervalSec } from './settings-store';

export type SettingsIntervalListener = (sec: AutoRefreshIntervalSec) => void;

/**
 * Plugin-instance single-event bus for AutoRefreshIntervalSec changes.
 * Not a general emitter: one typed event, no string names, no bubbling.
 */
export class SettingsBus {
  private readonly listeners = new Set<SettingsIntervalListener>();
  private disposed = false;

  emit(sec: AutoRefreshIntervalSec): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(sec);
      } catch (err) {
        console.warn('[git-viewer] SettingsBus listener threw:', err);
      }
    }
  }

  on(listener: SettingsIntervalListener): Disposable {
    if (this.disposed) {
      return { dispose: () => {} };
    }

    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
  }
}
