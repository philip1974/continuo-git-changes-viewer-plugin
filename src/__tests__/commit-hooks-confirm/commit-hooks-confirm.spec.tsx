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
  lstat?: (p: string) => Promise<{ isDirectory: boolean; isSymlink: boolean }>;
  noFs?: boolean;
  noLstat?: boolean;
}) {
  const exec = vi.fn(async (_cmd: string, args: readonly string[]) => {
    if (args.includes('config')) return opts.config ?? ok(cfg(PLUGIN_OVERRIDE));
    if (args.includes('--git-common-dir')) return opts.commonDir ?? ok('.git\n');
    return ok('');
  });
  const listDir = vi.fn(opts.listDir ?? (async () => []));
  const lstat = vi.fn(
    opts.lstat ??
      (async () => ({ size: 0, mtimeMs: 0, isFile: false, isDirectory: true, isSymlink: false })),
  );
  const fs = opts.noLstat ? { listDir } : { listDir, lstat };
  const app = { shell: { exec }, ...(opts.noFs ? {} : { fs }) } as unknown as CoPluginApp;
  return { app, exec, listDir, lstat };
}

// 宿主 plugin-fs 的错误经 ipcRenderer.invoke 传回:只保留 message,形如
// "Error invoking remote method 'plugin-fs:lstat': Error: ENOENT: no such file or directory, lstat '<path>'"
function hostError(inner: string): Error {
  return new Error(`Error invoking remote method 'plugin-fs:lstat': ${inner}`);
}
function errno(code: string): Error {
  return Object.assign(new Error(`${code}: failure, lstat '/repo/.git/hooks'`), { code });
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

  it('H16 config-defined hooks (hook.<name>.*, git >= 2.54) in local / worktree config → present, even when a global core.hooksPath would otherwise mean none; global ones are user-owned', async () => {
    for (const scope of ['local', 'worktree']) {
      const { app, listDir } = mockApp({
        config: ok(
          cfg(
            ['global', 'core.hookspath', '~/hooks'],
            [scope, 'hook.lint.event', 'pre-commit'],
            [scope, 'hook.lint.command', 'sh ./x.sh'],
            [scope, 'hook.lint.event', 'post-commit'],
            PLUGIN_OVERRIDE,
            ['command', 'hook.pre-commit.enabled', 'false'],
          ),
        ),
      });
      expect(await detectRepoHooks(app, '/repo')).toEqual({
        kind: 'present',
        hooks: ['hook.lint.command', 'hook.lint.event'],
        hooksPath: null,
      });
      expect(listDir).not.toHaveBeenCalled();
    }
    const userOwned = mockApp({
      config: ok(cfg(['global', 'hook.lint.event', 'pre-commit'], ['system', 'hook.lint.command', 'x'], ['command', 'hook.pre-commit.enabled', 'false'])),
      listDir: async () => [],
    });
    expect(await detectRepoHooks(userOwned.app, '/repo')).toEqual({ kind: 'none' });
  });

  it('H4c scopes other than global / system / command count as repository-controlled: core.hooksPath or hook.* there → present; malformed config output → unknown', async () => {
    for (const scope of ['unknown', 'submodule', 'remote']) {
      const path = mockApp({ config: ok(cfg(['global', 'core.hookspath', '~/hooks'], [scope, 'core.hookspath', 'evil'], PLUGIN_OVERRIDE)) });
      expect(await detectRepoHooks(path.app, '/repo')).toEqual({ kind: 'present', hooks: [], hooksPath: 'evil' });
      const hook = mockApp({ config: ok(cfg([scope, 'hook.lint.command', 'x'], PLUGIN_OVERRIDE)) });
      expect(await detectRepoHooks(hook.app, '/repo')).toEqual({ kind: 'present', hooks: ['hook.lint.command'], hooksPath: null });
    }
    expect((await detectRepoHooks(mockApp({ config: ok('core.hookspath\nevil\0') }).app, '/repo')).kind).toBe('unknown');
    expect((await detectRepoHooks(mockApp({ config: ok('\0core.hookspath\nevil\0') }).app, '/repo')).kind).toBe('unknown');
  });

  it('H5 git config / rev-parse failures and missing app.fs fail closed to unknown', async () => {
    expect((await detectRepoHooks(mockApp({ config: fail() }).app, '/repo')).kind).toBe('unknown');
    expect((await detectRepoHooks(mockApp({ config: { ...ok(''), truncated: true } }).app, '/repo')).kind).toBe('unknown');
    expect((await detectRepoHooks(mockApp({ commonDir: fail() }).app, '/repo')).kind).toBe('unknown');
    expect((await detectRepoHooks(mockApp({ noFs: true }).app, '/repo')).kind).toBe('unknown');
  });

  it('H6 only an explicit ENOENT from lstat(<common-dir>/hooks) means none (raw errno or host IPC message)', async () => {
    for (const err of [
      errno('ENOENT'),
      hostError("Error: ENOENT: no such file or directory, lstat '/repo/.git/hooks'"),
      new Error("ENOENT: no such file or directory, lstat '/repo/.git/hooks'"),
    ]) {
      const { app, listDir, lstat } = mockApp({
        lstat: async () => {
          throw err;
        },
      });
      expect(await detectRepoHooks(app, '/repo')).toEqual({ kind: 'none' });
      expect(lstat).toHaveBeenCalledWith('/repo/.git/hooks');
      expect(listDir).not.toHaveBeenCalled();
    }
  });

  it('H7 any other lstat failure (scope error, EACCES, ENOENT only inside the path text) or no lstat API → unknown', async () => {
    for (const err of [
      hostError("ScopeError: path '/evil/hooks' is outside granted scopes"),
      hostError("Error: EACCES: permission denied, lstat '/repo/.git/hooks'"),
      errno('EACCES'),
      hostError("ScopeError: path '/tmp/x: ENOENT: no such file or directory/.git/hooks' is outside granted scopes"),
      new Error('boom'),
    ]) {
      const { app } = mockApp({
        lstat: async () => {
          throw err;
        },
      });
      expect(await detectRepoHooks(app, '/repo')).toMatchObject({ kind: 'unknown' });
    }
    expect((await detectRepoHooks(mockApp({ noLstat: true }).app, '/repo')).kind).toBe('unknown');
  });

  it('H13 hooks directory exists but cannot be listed → unknown (never treated as missing)', async () => {
    for (const err of [errno('ENOENT'), errno('EACCES'), hostError('ScopeError: outside granted scopes')]) {
      const { app } = mockApp({
        listDir: async () => {
          throw err;
        },
      });
      expect((await detectRepoHooks(app, '/repo')).kind).toBe('unknown');
    }
  });

  it('H14 hooks is a symlink: listed through the (scope-checked) link when readable, unknown when it points outside the workspace', async () => {
    const link = async () => ({ isDirectory: false, isSymlink: true });
    // repo/.git/hooks -> ../../evilhooks:宿主对 listDir 先 realpath 再判 scope → ScopeError
    const outside = mockApp({
      lstat: link,
      listDir: async () => {
        throw hostError("ScopeError: '/evilhooks' is outside granted scopes");
      },
    });
    expect(await detectRepoHooks(outside.app, '/repo')).toMatchObject({ kind: 'unknown' });

    const inside = mockApp({ lstat: link, listDir: async () => [entry('pre-commit')] });
    expect(await detectRepoHooks(inside.app, '/repo')).toEqual({ kind: 'present', hooks: ['pre-commit'], hooksPath: null });
  });

  it('H15 hooks path is neither a directory nor a symlink (e.g. a regular file) → unknown', async () => {
    const { app, listDir } = mockApp({ lstat: async () => ({ isDirectory: false, isSymlink: false }) });
    expect((await detectRepoHooks(app, '/repo')).kind).toBe('unknown');
    expect(listDir).not.toHaveBeenCalled();
  });
});

function renderEditor(detectHooks: (app: CoPluginApp, root: string) => Promise<RepoHooks>, amend = false) {
  const store = createGitStore();
  store.setState({ repoRoot: '/repo', commitMessage: 'subject', amend, amendHead: amend ? 'sha' : null, statusFingerprint: 'fp' }); // 提交前确认(commit-editor T31–T35):store 里的指纹与当前读到的相同才提交
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
      readFingerprint={async () => 'fp'}
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
    // 未经确认的提交不带 hooksConfirmed → 断网运行(见 exec T4)
    expect(commit).toHaveBeenCalledWith(expect.anything(), '/repo', 'subject', { amend: false });
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
    expect(commit).toHaveBeenCalledWith(expect.anything(), '/repo', 'subject', { amend: false, hooksConfirmed: true });
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
      expect(commit).toHaveBeenCalledWith(expect.anything(), '/repo', 'subject', { amend: true, hooksConfirmed: true }),
    );
  });
});
