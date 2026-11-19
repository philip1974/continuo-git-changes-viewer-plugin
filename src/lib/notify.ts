import type { CoNotificationsShowOpts, CoPluginApp } from '../sdk/types';

/**
 * 显示一条宿主通知。宿主没有通知 API → false;宿主拒绝(插件被吊销后 `notifications.show` 同步抛
 * PERMISSION_DENIED)→ 记录到 console,返回 false。**从不抛出**:通知常在 catch 分支里报告失败,它再抛出
 * 就留下未处理的 rejection,成功路径上之后的刷新 / 收尾也被跳过。
 * 返回 false 时由调用方决定退路(面板内 banner,或不再提示)。
 */
export function tryNotify(app: Pick<CoPluginApp, 'notifications'> | undefined, opts: CoNotificationsShowOpts): boolean {
  const notifications = app?.notifications;
  if (typeof notifications?.show !== 'function') return false;
  try {
    notifications.show(opts);
    return true;
  } catch (err) {
    console.warn('[git-viewer] notification refused by the host:', opts.message, err);
    return false;
  }
}
