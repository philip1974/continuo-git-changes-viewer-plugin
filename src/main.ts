import {
  co,
  type CoPluginApp,
  type Disposable,
  type PanelFactoryProps,
  type PluginManifest,
} from './sdk/types';
import { registerCommands } from './commands';
import { detectRepo } from './git/repo-detect';
import { scanStatus } from './git/status-scanner';
import { fetchDiff } from './git/diff-fetcher';
import { SettingsBus } from './lib/settings-bus';
import { AutoRefreshTimer } from './state/auto-refresh-timer';
import { createGitStore } from './state/git-store';
import { GitViewerPanel } from './panel/GitViewerPanel';
import { SettingsTab } from './panel/SettingsTab';
import type { NotificationKind } from './sdk/types';
import { toBannerKind } from './lib/notification-mapping';
// v0.1.2 hotfix: Continuo plugin loader 只载 dist/index.js，不自动 link dist/style.css
// → CSS 用 `?inline` import 拿字符串，onload 时 appendChild <style> 注入到 document.head。
import css from './styles/index.css?inline';

const { Plugin, React } = co;

type ScopeReadyState = 'grant' | 'deny' | 'no-workspace' | 'error';

function gitCompareIcon() {
  return React.createElement(
    'svg',
    {
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    React.createElement('circle', { cx: 5, cy: 6, r: 3 }),
    React.createElement('circle', { cx: 19, cy: 18, r: 3 }),
    React.createElement('path', { d: 'M12 6h5a2 2 0 0 1 2 2v7' }),
    React.createElement('path', { d: 'M12 18H7a2 2 0 0 1-2-2V9' }),
  );
}

export default class GitChangesViewerPlugin extends Plugin {
  private readonly disposables: Disposable[] = [];
  private readonly timer = new AutoRefreshTimer();
  private readonly settingsBus = new SettingsBus();
  store = createGitStore();
  scopeReadyPromise: Promise<ScopeReadyState> = Promise.resolve('error');

  constructor(app: CoPluginApp, manifest: PluginManifest) {
    super(app, manifest);
  }

  get scopeReady(): Promise<ScopeReadyState> {
    return this.scopeReadyPromise;
  }

  private showNotification(
    kind: NotificationKind,
    message: string,
    code?: string,
  ): void {
    if (typeof this.app.notifications?.show === 'function') {
      this.app.notifications.show(
        code === undefined ? { kind, message } : { kind, message, code },
      );
      return;
    }

    // Defensive fallback only. The SDK toast has no dismissable field; inline
    // banners keep it because the panel banner UI supports manual dismissal.
    this.store.getState().setBanner({
      kind: toBannerKind(kind),
      message,
      dismissable: true,
    });
  }

  override async onload(): Promise<void> {
    // v0.1.2 hotfix: 注入 CSS 一次（dedupe by id 防 enable/disable 重复）
    const STYLE_ID = 'cgv-plugin-css';
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = css;
      document.head.appendChild(style);
      this.disposables.push({
        dispose: () => style.remove(),
      });
    }

    const store = createGitStore({
      load: async () => {
        const repo = await detectRepo(this.app);
        if (!repo.ok) {
          const message =
            repo.reason === 'no-workspace'
              ? 'Open a workspace before refreshing Git changes.'
              : 'Git Changes Viewer v0.1 requires the workspace root to be the git toplevel.';
          this.showNotification('warning', message);
          return { repoRoot: repo.root ?? null, changes: [] };
        }

        return {
          repoRoot: repo.root,
          changes: await scanStatus(this.app, repo.root),
        };
      },
      fetchDiff: (repoRoot, change, mode) =>
        fetchDiff(this.app, repoRoot, change, mode),
    });
    this.store = store;

    const panel = this.app.panels.register({
      type: 'git-changes-viewer',
      title: 'Git Changes Viewer',
      factory: (props: PanelFactoryProps) =>
        React.createElement(GitViewerPanel, {
          app: this.app,
          scopeReady: this.scopeReadyPromise,
          store,
          panelApi: props.api,
          timer: this.timer,
          pluginId: this.manifest.id,
          settingsBus: this.settingsBus,
        }),
    });
    this.disposables.push(panel);

    const settingTab = this.app.settingTabs?.register({
      id: 'git-changes-viewer-settings',
      title: 'Git Changes',
      render: () =>
        React.createElement(SettingsTab, {
          app: this.app,
          pluginId: this.manifest.id,
          bus: this.settingsBus,
        }),
    });
    if (settingTab) this.disposables.push(settingTab);

    this.disposables.push({
      dispose: () => this.settingsBus.dispose(),
    });

    this.disposables.push({
      dispose: () => this.timer.stop(),
    });

    this.disposables.push(
      registerCommands(this.app, {
        refresh: () => store.getState().refresh(),
      }),
    );

    if (typeof this.app.dock?.openPanel === 'function') {
      const ribbon = this.app.ribbon.register({
        id: 'git-changes-viewer-open',
        title: 'Git Changes',
        icon: gitCompareIcon(),
        onClick: () => {
          try {
            this.app.dock?.openPanel('git-changes-viewer');
          } catch {
            // Defensive only: topic-31 host dock.openPanel is specified no-throw.
          }
        },
        priority: 100,
      });
      this.disposables.push(ribbon);
    }

    this.scopeReadyPromise = this.requestScopeOnce();
  }

  private async requestScopeOnce(): Promise<ScopeReadyState> {
    try {
      const root = await this.app.workspace.getRoot();
      if (!root) {
        this.showNotification(
          'warning',
          'Open a workspace folder to enable jump-back',
        );
        return 'no-workspace';
      }

      // v0.1.6 hot-fix: realpath enforce scope itself → chicken-and-egg before grant.
      // Skip canonicalize; symlink edge case deferred to v0.1.7+.
      const result = await this.app.fs.requestScope([
        { path: root, mode: 'r' },
      ]);
      if (result === 'deny') {
        this.showNotification('warning', 'fs scope denied; jump-back disabled');
        return 'deny';
      }

      return 'grant';
    } catch (err) {
      const PermissionError = globalThis.co?.PermissionError;
      const isPermissionError =
        PermissionError !== undefined && err instanceof PermissionError;
      this.showNotification(
        'error',
        isPermissionError
          ? "Please grant 'fs' permission via Plugin Manager"
          : `Setup failed: ${err instanceof Error ? err.message : String(err)}`,
        isPermissionError ? 'PERMISSION_DENIED' : undefined,
      );
      return 'error';
    }
  }

  override async onunload(): Promise<void> {
    for (const disposable of this.disposables.reverse()) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
