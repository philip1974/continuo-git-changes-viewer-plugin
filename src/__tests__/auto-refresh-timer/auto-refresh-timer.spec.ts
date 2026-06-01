import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoRefreshTimer } from '../../state/auto-refresh-timer';

describe('AutoRefreshTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('T1 start creates an interval and stop clears it', () => {
    const timer = new AutoRefreshTimer();
    const onTick = vi.fn();

    timer.start({ intervalMs: 2000, onTick });

    expect(timer.isRunning()).toBe(true);

    timer.stop();

    expect(timer.isRunning()).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('T2 start is idempotent and replaces an existing interval', async () => {
    const timer = new AutoRefreshTimer();
    const firstTick = vi.fn();
    const secondTick = vi.fn();

    timer.start({ intervalMs: 2000, onTick: firstTick });
    timer.start({ intervalMs: 5000, onTick: secondTick });

    await vi.advanceTimersByTimeAsync(2000);
    expect(firstTick).not.toHaveBeenCalled();
    expect(secondTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(secondTick).toHaveBeenCalledTimes(1);
  });

  it('T3 rejects intervals below two seconds', () => {
    const timer = new AutoRefreshTimer();

    timer.start({ intervalMs: 1999, onTick: vi.fn() });

    expect(timer.isRunning()).toBe(false);
  });

  it('T4 blocks re-entry while a tick is in flight', async () => {
    const timer = new AutoRefreshTimer();
    let release = () => {};
    const onTick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    timer.start({ intervalMs: 2000, onTick });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(onTick).toHaveBeenCalledTimes(1);

    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000);

    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it('T5 dedupes the same error message for sixty seconds', async () => {
    const timer = new AutoRefreshTimer();
    const onError = vi.fn();

    timer.start({
      intervalMs: 2000,
      onTick: () => {
        throw new Error('git failed');
      },
      onError,
    });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    vi.setSystemTime(new Date('2026-05-31T00:01:01Z'));
    await vi.advanceTimersByTimeAsync(2000);

    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('T5b reports distinct error messages without dedupe', async () => {
    const timer = new AutoRefreshTimer();
    const onError = vi.fn();
    const messages = ['git failed', 'permission denied'];

    timer.start({
      intervalMs: 2000,
      onTick: () => {
        throw new Error(messages.shift() ?? 'permission denied');
      },
      onError,
    });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(onError).toHaveBeenCalledTimes(2);
  });
});
