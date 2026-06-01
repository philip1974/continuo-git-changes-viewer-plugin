import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsBus } from '../../lib/settings-bus';

describe('SettingsBus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T1 emits interval changes to a subscribed listener', () => {
    const bus = new SettingsBus();
    const listener = vi.fn();

    bus.on(listener);
    bus.emit(2);

    expect(listener).toHaveBeenCalledWith(2);
  });

  it('T2 emits interval changes to multiple listeners', () => {
    const bus = new SettingsBus();
    const first = vi.fn();
    const second = vi.fn();

    bus.on(first);
    bus.on(second);
    bus.emit(10);

    expect(first).toHaveBeenCalledWith(10);
    expect(second).toHaveBeenCalledWith(10);
  });

  it('T3 isolates a throwing listener and warns once', () => {
    const bus = new SettingsBus();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const afterThrow = vi.fn();

    bus.on(() => {
      throw new Error('listener failed');
    });
    bus.on(afterThrow);
    bus.emit(5);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(afterThrow).toHaveBeenCalledWith(5);
  });

  it('T4 dispose clears listeners', () => {
    const bus = new SettingsBus();
    const listener = vi.fn();

    bus.on(listener);
    bus.dispose();
    bus.emit(2);

    expect(listener).not.toHaveBeenCalled();
  });

  it('T4.5 subscribing after dispose returns a no-op disposable', () => {
    const bus = new SettingsBus();
    const listener = vi.fn();

    bus.dispose();
    const disposable = bus.on(listener);
    disposable.dispose();
    bus.emit(2);

    expect(listener).not.toHaveBeenCalled();
  });

  it('T5 emit after dispose is a no-op', () => {
    const bus = new SettingsBus();
    const listener = vi.fn();

    bus.on(listener);
    bus.dispose();
    bus.emit(10);

    expect(listener).not.toHaveBeenCalled();
  });
});
