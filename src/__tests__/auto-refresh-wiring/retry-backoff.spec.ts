import { describe, expect, it } from 'vitest';
import { RetryBackoff, MAX_RETRY_GAP_MS } from '../../state/retry-backoff';

// 每个 tick 问一次 due();失败后调用 failed()。返回发生重试的 tick 序号。
function retryTicks(intervalMs: number, ticks: number): number[] {
  const backoff = new RetryBackoff(intervalMs);
  const ran: number[] = [];
  for (let tick = 1; tick <= ticks; tick++) {
    if (!backoff.due()) continue;
    ran.push(tick);
    backoff.failed();
  }
  return ran;
}

describe('RetryBackoff (ticks between retries of a failing refresh)', () => {
  it('B1 the first attempt is immediate; gaps double (1, 2, 4, 8 … ticks) and are capped so retries are never more than about a minute apart', () => {
    expect(MAX_RETRY_GAP_MS).toBe(60_000);
    expect(retryTicks(5_000, 40)).toEqual([1, 3, 7, 15, 27, 39]);
    expect(retryTicks(2_000, 100)).toEqual([1, 3, 7, 15, 31, 61, 91]);
    expect(retryTicks(30_000, 8)).toEqual([1, 3, 5, 7]);
  });

  it('B2 an interval of a minute or more retries on every tick (the interval itself is the spacing)', () => {
    expect(retryTicks(60_000, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(retryTicks(300_000, 3)).toEqual([1, 2, 3]);
  });

  it('B3 reset() makes the next attempt immediate and starts the gaps over', () => {
    const backoff = new RetryBackoff(5_000);
    expect(backoff.due()).toBe(true);
    backoff.failed();
    backoff.failed();
    expect(backoff.due()).toBe(false);
    backoff.reset();
    expect(backoff.due()).toBe(true);
    backoff.failed();
    expect([backoff.due(), backoff.due()]).toEqual([false, true]);
  });
});
