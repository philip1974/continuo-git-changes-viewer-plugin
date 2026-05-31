import { describe, expect, it } from 'vitest';
import { toBannerKind, toNotificationKind } from '../../lib/notification-mapping';

describe('notification kind mapping helpers', () => {
  it('T8a maps inline banner kinds to SDK notification kinds', () => {
    expect(toNotificationKind('info')).toBe('info');
    expect(toNotificationKind('warn')).toBe('warning');
    expect(toNotificationKind('error')).toBe('error');
  });

  it('T8b maps SDK notification kinds to inline banner kinds', () => {
    expect(toBannerKind('info')).toBe('info');
    expect(toBannerKind('warning')).toBe('warn');
    expect(toBannerKind('error')).toBe('error');
    expect(toBannerKind('success')).toBe('info');
  });
});
