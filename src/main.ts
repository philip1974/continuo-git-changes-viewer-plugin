import { co, type CoPluginApp, type Disposable, type PluginManifest } from './sdk/types';
import { registerCommands } from './commands';
import { detectRepo } from './git/repo-detect';
import { scanStatus } from './git/status-scanner';
import { fetchDiff } from './git/diff-fetcher';
import { createGitStore } from './state/git-store';
import { GitViewerPanel } from './panel/GitViewerPanel';
// v0.1.2 hotfix: Continuo plugin loader 只载 dist/index.js，不自动 link dist/style.css
// → CSS 用 `?inline` import 拿字符串，onload 时 appendChild <style> 注入到 document.head。
import css from './styles/index.css?inline';

const { Plugin, React } = co;

export default class GitChangesViewerPlugin extends Plugin {
  private readonly disposables: Disposable[] = [];

  constructor(app: CoPluginApp, manifest: PluginManifest) {
    super(app, manifest);
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
          store.getState().setBanner({
            kind: 'warn',
            message,
            dismissable: true,
          });
          return { repoRoot: repo.root ?? null, changes: [] };
        }

        return {
          repoRoot: repo.root,
          changes: await scanStatus(this.app, repo.root),
        };
      },
      fetchDiff: (repoRoot, change) => fetchDiff(this.app, repoRoot, change),
    });

    const panel = this.app.panels.register({
      type: 'git-changes-viewer',
      title: 'Git Changes Viewer',
      factory: () => React.createElement(GitViewerPanel, { store }),
    });
    this.disposables.push(panel);

    this.disposables.push(
      registerCommands(this.app, {
        refresh: () => store.getState().refresh(),
      }),
    );
  }

  override async onunload(): Promise<void> {
    for (const disposable of this.disposables.reverse()) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
