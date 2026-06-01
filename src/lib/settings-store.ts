export const AUTO_REFRESH_INTERVALS = [0, 2, 5, 10] as const;
export type AutoRefreshIntervalSec = (typeof AUTO_REFRESH_INTERVALS)[number];

export const DEFAULT_AUTO_REFRESH_INTERVAL_SEC: AutoRefreshIntervalSec = 5;

type DataStoreReader = {
  read(pluginId: string): Promise<unknown>;
};

type DataStoreWriter = DataStoreReader & {
  write(pluginId: string, data: unknown): Promise<void>;
};

type SettingsBlob = Record<string, unknown> & {
  autoRefresh?: {
    intervalSec?: unknown;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeAutoRefreshIntervalSec(
  value: unknown,
): AutoRefreshIntervalSec {
  if (
    typeof value === 'number' &&
    (AUTO_REFRESH_INTERVALS as readonly number[]).includes(value)
  ) {
    return value as AutoRefreshIntervalSec;
  }
  return DEFAULT_AUTO_REFRESH_INTERVAL_SEC;
}

function readIntervalFromBlob(blob: unknown): AutoRefreshIntervalSec {
  if (!isRecord(blob)) return DEFAULT_AUTO_REFRESH_INTERVAL_SEC;
  const autoRefresh = blob.autoRefresh;
  if (!isRecord(autoRefresh)) return DEFAULT_AUTO_REFRESH_INTERVAL_SEC;
  return normalizeAutoRefreshIntervalSec(autoRefresh.intervalSec);
}

export async function readAutoRefreshIntervalSec(
  dataStore: DataStoreReader,
  pluginId: string,
): Promise<AutoRefreshIntervalSec> {
  try {
    return readIntervalFromBlob(await dataStore.read(pluginId));
  } catch {
    return DEFAULT_AUTO_REFRESH_INTERVAL_SEC;
  }
}

export async function writeAutoRefreshIntervalSec(
  dataStore: DataStoreWriter,
  pluginId: string,
  intervalSec: AutoRefreshIntervalSec,
): Promise<void> {
  let current: SettingsBlob = {};
  try {
    const blob = await dataStore.read(pluginId);
    if (isRecord(blob)) current = { ...blob };
  } catch {
    current = {};
  }

  await dataStore.write(pluginId, {
    ...current,
    autoRefresh: { intervalSec },
  });
}
