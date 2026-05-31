import { co, type CoPluginApp, type Disposable, type PluginManifest } from './sdk/types';
import { registerCommands } from './commands';
import { detectRepo } from './git/repo-detect';
import { scanStatus } from './git/status-scanner';
import { createGitStore } from './state/git-store';
import { GitViewerPanel } from './panel/GitViewerPanel';

const { Plugin, React } = co;

export default class GitChangesViewerPlugin extends Plugin {
  private readonly disposables: Disposable[] = [];

  constructor(app: CoPluginApp, manifest: PluginManifest) {
    super(app, manifest);
  }

  override async onload(): Promise<void> {
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
