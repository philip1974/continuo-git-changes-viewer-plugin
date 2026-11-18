import {
  co,
  type CoPluginApp,
  type Disposable,
  type PanelFactoryProps,
  type PluginManifest,
} from './sdk/types';
import { registerCommands } from './commands';
import { detectRepo } from './git/repo-detect';
import { installRepoSafetyGuard } from './git/repo-safety';
import { scanStatus, StatusUnavailableError, UnsafeIndexError } from './git/status-scanner';
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

    // 安全:此后本插件所有经 gitExec 的 git 调用都先过受限仓库检测(fail-closed)。
    const safety = installRepoSafetyGuard(this.app);
    this.disposables.push(safety);

    const store = createGitStore({
      load: async () => {
        // 每次 refresh 都强制重新探测(不走缓存),再运行任何 git 命令。
        // 探测要经 app.fs 检查 git 目录内的符号链接,先等 fs scope 请求结束(未授权时探测会判受限)。
        await this.scopeReadyPromise;
        const root = await this.app.workspace.getRoot();
        if (root) {
          const verdict = await safety.guard.check(root, { fresh: true });
          if (verdict.kind === 'restricted') {
            return { repoRoot: null, changes: [], restriction: verdict.message };
          }
        }

        const repo = await detectRepo(this.app);
        if (!repo.ok) {
          const message =
            repo.reason === 'no-workspace'
              ? 'Open a workspace before refreshing Git changes.'
              : 'Git Changes Viewer v0.1 requires the workspace root to be the git toplevel.';
          this.showNotification('warning', message);
          return { repoRoot: repo.root ?? null, changes: [] };
        }

        try {
          return { repoRoot: repo.root, changes: await scanStatus(this.app, repo.root) };
        } catch (err) {
          if (err instanceof StatusUnavailableError) {
            // status 失败 / 超时 / 被截断:列表不可信。仓库本身没有问题(不受限),但面板要说明原因并禁用
            // Commit / Amend(见 git-store 的 statusError);截断时仍显示已读到的那部分。
            return { repoRoot: repo.root, changes: [...err.partial], statusError: err.message };
          }
          if (!(err instanceof UnsafeIndexError)) throw err;
          // 伪造的 index:与其它受限情形同样处理——不显示列表,并让守卫拒绝此后的一切 git 调用
          // (否则 commit 会把面板没显示的条目写进 tree)。下一次 refresh 重新判断。
          safety.guard.restrict(repo.root, { kind: 'restricted', reason: 'unsafe-index', keys: [], message: err.message });
          return { repoRoot: null, changes: [], restriction: err.message };
        }
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
