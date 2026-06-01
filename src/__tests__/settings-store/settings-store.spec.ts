import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_REFRESH_INTERVALS,
  readAutoRefreshIntervalSec,
  writeAutoRefreshIntervalSec,
} from '../../lib/settings-store';

describe('auto-refresh settings store helpers', () => {
  it('T7 defaults missing data to five seconds', async () => {
    const dataStore = { read: vi.fn(async () => null) };

    await expect(
      readAutoRefreshIntervalSec(dataStore, 'git-viewer'),
    ).resolves.toBe(5);
    expect(AUTO_REFRESH_INTERVALS).toEqual([0, 2, 5, 10]);
    expect(dataStore.read).toHaveBeenCalledWith('git-viewer');
  });

  it('T7b defaults corrupt blobs to five seconds', async () => {
    const dataStore = {
      read: vi.fn(async () => ({ autoRefresh: { intervalSec: 1 } })),
    };

    await expect(
      readAutoRefreshIntervalSec(dataStore, 'git-viewer'),
    ).resolves.toBe(5);
  });

  it('T7c defaults read failures to five seconds', async () => {
    const dataStore = {
      read: vi.fn(async () => {
        throw new Error('store unavailable');
      }),
    };

    await expect(
      readAutoRefreshIntervalSec(dataStore, 'git-viewer'),
    ).resolves.toBe(5);
  });

  it('T8 writes the interval by merging the existing plugin blob', async () => {
    const write = vi.fn(async () => {});
    const dataStore = {
      read: vi.fn(async () => ({ theme: 'dark', autoRefresh: { intervalSec: 10 } })),
      write,
    };

    await writeAutoRefreshIntervalSec(dataStore, 'git-viewer', 2);

    expect(write).toHaveBeenCalledWith('git-viewer', {
      theme: 'dark',
      autoRefresh: { intervalSec: 2 },
    });
  });

  it('T8b propagates write failures', async () => {
    const dataStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => {
        throw new Error('write failed');
      }),
    };

    await expect(
      writeAutoRefreshIntervalSec(dataStore, 'git-viewer', 10),
    ).rejects.toThrow('write failed');
  });
});
