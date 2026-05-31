import type { NotificationKind } from '../sdk/types';

export type BannerKind = 'info' | 'warn' | 'error';

export function toNotificationKind(banner: BannerKind): NotificationKind {
  if (banner === 'warn') return 'warning';
  return banner;
}

export function toBannerKind(notification: NotificationKind): BannerKind {
  if (notification === 'warning') return 'warn';
  if (notification === 'success') return 'info';
  return notification;
}
