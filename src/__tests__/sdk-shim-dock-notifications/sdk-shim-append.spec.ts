import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  CoApp,
  CoDockApi,
  CoNotificationsApi,
  CoNotificationsShowOpts,
  NotificationKind,
} from '../../sdk/types';

const UPSTREAM_NOTIFICATION_LEVELS = [
  'info',
  'warning',
  'error',
  'success',
] as const;

describe('sdk shim dock + notifications additions', () => {
  it('T6 exports dock and notifications API shapes', () => {
    expectTypeOf<CoDockApi['openPanel']>().parameters.toEqualTypeOf<
      [panelId: string]
    >();
    expectTypeOf<CoDockApi['openPanel']>().returns.toEqualTypeOf<void>();
    expectTypeOf<CoNotificationsApi['show']>().parameters.toEqualTypeOf<
      [opts: CoNotificationsShowOpts]
    >();
    expectTypeOf<CoNotificationsApi['show']>().returns.toEqualTypeOf<void>();
  });

  it('T7 keeps CoApp dock and notifications optional for feature detection', () => {
    expectTypeOf<CoApp['dock']>().toEqualTypeOf<CoDockApi | undefined>();
    expectTypeOf<CoApp['notifications']>().toEqualTypeOf<
      CoNotificationsApi | undefined
    >();
  });

  it('T7.5 keeps NotificationKind literals in sync with upstream NotificationLevel', () => {
    const shimLevels = [
      'info',
      'warning',
      'error',
      'success',
    ] satisfies readonly NotificationKind[];

    expect([...shimLevels].sort()).toEqual(
      [...UPSTREAM_NOTIFICATION_LEVELS].sort(),
    );
  });
});
