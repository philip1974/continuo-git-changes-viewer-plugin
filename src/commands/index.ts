import type { CoPluginApp, Disposable } from '../sdk/types';

export interface RefreshStore {
  refresh(): Promise<void> | void;
}

export function registerCommands(
  app: Pick<CoPluginApp, 'commands'>,
  store: RefreshStore,
): Disposable {
  return app.commands.register({
    id: 'git-viewer.refresh',
    title: 'Refresh Git Changes',
    category: 'Git',
    fn: () => store.refresh(),
  });
}
