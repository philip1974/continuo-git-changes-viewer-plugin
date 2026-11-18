// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectRepoHooks, type RepoHooks } from '../../git/repo-hooks';
import { CommitEditor } from '../../panel/CommitEditor';
import type { CoPluginApp, FileEntry, PluginShellExecResult } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';

afterEach(() => cleanup());

function ok(stdout: string): PluginShellExecResult {
  return { stdout, stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false };
}
function fail(): PluginShellExecResult {
  return { stdout: '', stderr: 'boom', exitCode: 128, signal: null, timedOut: false, truncated: false };
}
const cfg = (...entries: Array<[string, string, string]>) =>
  entries.map(([scope, key, value]) => `${scope}\0${key}\n${value}\0`).join('');
const PLUGIN_OVERRIDE: [string, string, string] = ['command', 'core.hookspath', '/dev/null'];

function entry(name: string, isDirectory = false): FileEntry {
  return { name, isFile: !isDirectory, isDirectory, isSymlink: false };
}

function mockApp(opts: {
  config?: PluginShellExecResult;
  commonDir?: PluginShellExecResult;
  listDir?: (p: string) => Promise<readonly FileEntry[]>;
  stat?: (p: string) => Promise<{ isDirectory: boolean }>;
  noFs?: boolean;
}) {
  const exec = vi.fn(async (_cmd: string, args: readonly string[]) => {
    if (args.includes('config')) return opts.config ?? ok(cfg(PLUGIN_OVERRIDE));
    if (args.includes('--git-common-dir')) return opts.commonDir ?? ok('.git\n');
    return ok('');
  });
  const listDir = vi.fn(opts.listDir ?? (async () => []));
  const stat = vi.fn(
    opts.stat ??
      (async () => ({ size: 0, mtimeMs: 0, isFile: false, isDirectory: true, isSymlink: false })),
  );
  const app = { shell: { exec }, ...(opts.noFs ? {} : { fs: { listDir, stat } }) } as unknown as CoPluginApp;
  return { app, exec, listDir, stat };
}

describe('detectRepoHooks', () => {
  it('H1 only .sample files (and directories) in <common-dir>/hooks → none; path resolved against repo root', async () => {
    const { app, listDir } = mockApp({
      listDir: async () => [entry('pre-commit.sample'), entry('post-update.sample'), entry('lib', true)],
    });
    expect(await detectRepoHooks(app, '/repo/')).toEqual({ kind: 'none' });
    expect(listDir).toHaveBeenCalledWith('/repo/.git/hooks');
  });

  it('H2 a non-sample hook file → present with sorted hook names; absolute common dir used as is', async () => {
    const { app, listDir } = mockApp({
      commonDir: ok('/main/.git\n'),
      listDir: async () => [entry('post-index-change'), entry('pre-commit.sample'), entry('post-checkout')],
    });
    expect(await detectRepoHooks(app, '/wt')).toEqual({
      kind: 'present',
      hooks: ['post-checkout', 'post-index-change'],
      hooksPath: null,
    });
    expect(listDir).toHaveBeenCalledWith('/main/.git/hooks');
  });

  it('H3 local / worktree core.hooksPath → present; the plugin\'s own command-scope /dev/null is ignored', async () => {
    for (const scope of ['local', 'worktree']) {
      const { app, listDir } = mockApp({
        config: ok(cfg(['local', 'core.bare', 'false'], [scope, 'core.hookspath', '.husky'], PLUGIN_OVERRIDE)),
      });
      expect(await detectRepoHooks(app, '/repo')).toEqual({ kind: 'present', hooks: [], hooksPath: '.husky' });
      expect(listDir).not.toHaveBeenCalled();
    }
  });

  it('H4 core.hooksPath only from global / system → none (user-owned); local overrides global', async () => {
    const globalOnly = mockApp({ config: ok(cfg(['global', 'core.hookspath', '~/hooks'], PLUGIN_OVERRIDE)) });
    expect(await detectRepoHooks(globalOnly.app, '/repo')).toEqual({ kind: 'none' });
    expect(globalOnly.listDir).not.toHaveBeenCalled();

    const both = mockApp({
      config: ok(cfg(['global', 'core.hookspath', '~/hooks'], ['local', 'core.hookspath', 'evil'], PLUGIN_OVERRIDE)),
    });
    expect(await detectRepoHooks(both.app, '/repo')).toMatchObject({ kind: 'present', hooksPath: 'evil' });
  });

  it('H5 git config / rev-parse failures and missing app.fs fail closed to unknown', async () => {
    expect((await detectRepoHooks(mockApp({ config: fail() }).app, '/repo')).kind).toBe('unknown');
    expect((await detectRepoHooks(mockApp({ config: { ...ok(''), truncated: true } }).app, '/repo')).kind).toBe('unknown');
    expect((await detectRepoHooks(mockApp({ commonDir: fail() }).app, '/repo')).kind).toBe('unknown');
    expect((await detectRepoHooks(mockApp({ noFs: true }).app, '/repo')).kind).toBe('unknown');
  });

  it('H6 hooks directory missing while the git dir is readable → none', async () => {
    const { app } = mockApp({
      listDir: async () => {
        throw new Error('ENOENT');
      },
      stat: async (p) => {
        if (p.endsWith('/hooks')) throw new Error('ENOENT');
        return { isDirectory: true };
      },
    });
    expect(await detectRepoHooks(app, '/repo')).toEqual({ kind: 'none' });
  });

  it('H7 hooks directory unreadable (exists, or git dir itself unreadable) → unknown', async () => {
    const exists = mockApp({
      listDir: async () => {
        throw new Error('EACCES');
      },
    });
    expect((await detectRepoHooks(exists.app, '/repo')).kind).toBe('unknown');

    const noScope = mockApp({
      listDir: async () => {
        throw new Error('out of scope');
      },
      stat: async () => {
        throw new Error('out of scope');
      },
    });
    expect((await detectRepoHooks(noScope.app, '/repo')).kind).toBe('unknown');
  });
});

function renderEditor(detectHooks: (app: CoPluginApp, root: string) => Promise<RepoHooks>, amend = false) {
  const store = createGitStore();
  store.setState({ repoRoot: '/repo', commitMessage: 'subject', amend });
  const commit = vi.fn(async () => ({ ok: true as const }));
  const app = { shell: { exec: vi.fn() }, notifications: { show: vi.fn() } } as unknown as CoPluginApp;
  const detect = vi.fn(detectHooks);
  render(
    <CommitEditor
      app={app}
      store={store}
      repoRoot="/repo"
      commitMessage="subject"
      stagedCount={1}
      amend={amend}
      commit={commit}
      readSubject={async () => 'subject'}
      hasHeadCommit={async () => true}
      readHeadSha={async () => 'sha'}
      detectHooks={detect}
    />,
  );
  return { commit, detect, store };
}

const present: RepoHooks = { kind: 'present', hooks: ['post-index-change', 'pre-commit'], hooksPath: null };

describe('CommitEditor hooks confirmation', () => {
  it('H8 no hooks → commits directly without a prompt', async () => {
    const { commit, detect } = renderEditor(async () => ({ kind: 'none' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(detect).toHaveBeenCalledWith(expect.anything(), '/repo');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('H9 hooks present → shows the hook names and does not commit until confirmed', async () => {
    const { commit } = renderEditor(async () => present);
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('post-index-change, pre-commit');
    expect(alert.textContent).toContain('will run when you commit');
    expect(commit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Commit and run hooks' }));
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit).toHaveBeenCalledWith(expect.anything(), '/repo', 'subject', { amend: false });
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('H10 Cancel dismisses the prompt without committing; the next attempt re-detects', async () => {
    const { commit, detect } = renderEditor(async () => present);
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(commit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    await screen.findByRole('alert');
    expect(detect).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('H11 unknown (or a throwing detector) also prompts — fail-closed', async () => {
    const { commit } = renderEditor(async () => {
      throw new Error('fs gone');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not check this repository for git hooks (fs gone)');
    expect(commit).not.toHaveBeenCalled();
  });

  it('H12 amend with a local core.hooksPath asks before amending', async () => {
    const { commit } = renderEditor(async () => ({ kind: 'present', hooks: [], hooksPath: '.husky' }), true);
    fireEvent.click(screen.getByRole('button', { name: 'Amend last commit' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('core.hooksPath (.husky)');
    expect(commit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Amend and run hooks' }));
    await vi.waitFor(() =>
      expect(commit).toHaveBeenCalledWith(expect.anything(), '/repo', 'subject', { amend: true }),
    );
  });
});
