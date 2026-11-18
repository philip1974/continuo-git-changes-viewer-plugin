// @vitest-environment jsdom
// 真实面板 + 真实 git:面板显示的内容必须与 Commit 将提交的内容一致。这里渲染真正的 GitViewerPanel
// (真实 store / scanStatus / fetchDiff / readStatusHash),timer 由用例手动驱动。
import React from 'react';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchDiff } from '../../git/diff-fetcher';
import { readStatusHash } from '../../git/status-hash';
import { scanStatus } from '../../git/status-scanner';
import { AMEND_HEAD_CHANGED_MESSAGE, REPO_CHANGED_MESSAGE } from '../../panel/CommitEditor';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import type { CoPluginApp, Disposable, PanelApi, PanelVisibilityEvent, PluginShellExecOptions, PluginShellExecResult } from '../../sdk/types';
import type { AutoRefreshTimerOpts } from '../../state/auto-refresh-timer';
import { cacheKey, createGitStore } from '../../state/git-store';

// 每一步都要起真实的 git 进程:整套测试并行跑时,默认的 1 s 等待不够
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ENV, encoding: 'utf8' });

// 对应宿主 shell.exec / fs.lstat 的最小实现(见 repo-safety-real-git.spec.ts 的 realApp)
function realApp(intervalSec: number): CoPluginApp {
  const exec = (cmd: string, args: readonly string[], opts: PluginShellExecOptions = {}) =>
    new Promise<PluginShellExecResult>((resolve) => {
      const child = spawn(cmd, [...args], { cwd: opts.cwd, env: { ...ENV, ...(opts.env ?? {}) } });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('close', (code, signal) =>
        resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode: code, signal, timedOut: false, truncated: false }),
      );
      // 用例结束、临时仓库已删之后才发起的调用(cwd 不存在):按失败返回,不抛未处理的错误
      child.on('error', (e) => resolve({ stdout: '', stderr: String(e), exitCode: null, signal: null, timedOut: false, truncated: false }));
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input ?? '');
    });
  const lstat = async (p: string) => {
    const s = lstatSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink() };
  };
  const stat = async (p: string) => {
    const s = statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory(), isSymlink: false };
  };
  const listDir = async (p: string) =>
    readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory(), isSymlink: e.isSymbolicLink() }));
  return {
    shell: { exec },
    fs: { lstat, stat, listDir },
    dataStore: { read: async () => ({ autoRefresh: { intervalSec } }), write: async () => {} },
  } as unknown as CoPluginApp;
}

interface TestPanelApi extends PanelApi {
  emit(isVisible: boolean): void;
}
function panelApiStub(): TestPanelApi {
  const listeners: Array<(event: PanelVisibilityEvent) => void> = [];
  return {
    id: 'git-changes-viewer',
    isVisible: true,
    onDidVisibilityChange(cb: (event: PanelVisibilityEvent) => void): Disposable {
      listeners.push(cb);
      return { dispose: () => void listeners.splice(listeners.indexOf(cb), 1) };
    },
    emit(isVisible: boolean) {
      (this as { isVisible: boolean }).isVisible = isVisible;
      for (const listener of [...listeners]) listener({ isVisible });
    },
  };
}

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(realpathSync(tmpdir()), 'cgv-panel-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@t');
  writeFileSync(join(repo, 'f'), 'v0\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
});
afterEach(() => {
  cleanup();
  rmSync(repo, { recursive: true, force: true });
});

// 与 main.ts 的 load 相同的顺序:先指纹,后列表
function mount(intervalSec: number) {
  const app = realApp(intervalSec);
  const store = createGitStore({
    load: async () => {
      const statusFingerprint = await readStatusHash(app, repo).catch(() => null);
      return { repoRoot: repo, changes: await scanStatus(app, repo), statusFingerprint };
    },
    fetchDiff: (root, change, mode) => fetchDiff(app, root, change, mode),
  });
  const timer = { opts: null as AutoRefreshTimerOpts | null, starts: 0 };
  const panelApi = panelApiStub();
  render(
    <GitViewerPanel
      app={app}
      store={store}
      panelApi={panelApi}
      timer={{ start: (opts) => { timer.opts = opts; timer.starts += 1; }, stop: () => { timer.opts = null; } }}
      pluginId="git-viewer"
    />,
  );
  // 面板里实际渲染出来的 Staged 行内容(index 版本)
  const shown = () => {
    const { selected, diffCache } = store.getState();
    const diff = selected ? diffCache.get(cacheKey(selected.path, selected.mode)) : undefined;
    return diff?.ok ? `${selected!.mode}:${diff.modified}` : null;
  };
  return { app, store, timer, panelApi, shown };
}

// 提交之后面板自己的收尾(清空提交信息、refresh)做完,再让 afterEach 删仓库
const settled = (store: ReturnType<typeof mount>['store']) =>
  waitFor(() => expect(store.getState()).toMatchObject({ commitMessage: '', isLoading: false }));

describe('the panel shows what a commit would take after it was hidden (real panel, real git)', () => {
  it('P1 staged v1 shown → the panel is hidden (another dock tab) → the file is edited and staged again in a terminal → the panel is shown again: it shows v2 at once, without waiting for a tick, and the commit holds what is shown', async () => {
    writeFileSync(join(repo, 'f'), 'v1 reviewed\n');
    git(repo, 'add', 'f');
    const { store, timer, panelApi, shown } = mount(5);
    await waitFor(() => expect(timer.starts).toBe(1));
    await waitFor(() => expect(shown()).toBe('staged:v1 reviewed\n'));
    await timer.opts!.onTick();
    expect(shown()).toBe('staged:v1 reviewed\n');

    panelApi.emit(false);
    expect(timer.opts).toBeNull();
    writeFileSync(join(repo, 'f'), 'v2 not reviewed\n');
    git(repo, 'add', 'f');
    panelApi.emit(true);

    // 没有跑任何 tick
    await waitFor(() => expect(shown()).toBe('staged:v2 not reviewed\n'));
    await waitFor(() => expect(timer.starts).toBe(2));
    expect(screen.getByText('+v2 not reviewed')).toBeTruthy();

    store.getState().setCommitMessage('msg');
    const commit = (await screen.findByRole('button', { name: 'Commit staged changes' })) as HTMLButtonElement;
    await waitFor(() => expect(commit.disabled).toBe(false));
    fireEvent.click(commit);
    await waitFor(() => expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('msg'));
    expect(git(repo, 'cat-file', 'blob', 'HEAD:f')).toBe('v2 not reviewed\n');
    await settled(store);
  });
});

describe('a commit takes what the panel shows, or nothing (real panel, real git)', () => {
  const clickCommit = async () => {
    const commit = (await screen.findByRole('button', { name: 'Commit staged changes' })) as HTMLButtonElement;
    await waitFor(() => expect(commit.disabled).toBe(false));
    fireEvent.click(commit);
  };

  it('P2 auto-refresh off: staged v1 is shown, the file is staged again in a terminal, Commit is clicked — nothing is committed, the panel says the repository changed and now shows v2; a second click commits exactly that', async () => {
    writeFileSync(join(repo, 'f'), 'v1 reviewed\n');
    git(repo, 'add', 'f');
    const { store, timer, shown } = mount(0);
    await waitFor(() => expect(shown()).toBe('staged:v1 reviewed\n'));
    expect(timer.starts).toBe(0);

    writeFileSync(join(repo, 'f'), 'v2 not reviewed\n');
    git(repo, 'add', 'f');
    store.getState().setCommitMessage('msg');
    await clickCommit();

    await waitFor(() => expect(store.getState().banner).toEqual({ kind: 'warn', message: REPO_CHANGED_MESSAGE, dismissable: true }));
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('init');
    await waitFor(() => expect(shown()).toBe('staged:v2 not reviewed\n'));
    expect(store.getState().commitMessage).toBe('msg');

    await clickCommit();
    await waitFor(() => expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('msg'));
    expect(git(repo, 'cat-file', 'blob', 'HEAD:f')).toBe('v2 not reviewed\n');
    await settled(store);
  });

  it('P3 nothing changed in between: the first click commits what is shown', async () => {
    writeFileSync(join(repo, 'f'), 'v1 reviewed\n');
    git(repo, 'add', 'f');
    const { store, shown } = mount(0);
    await waitFor(() => expect(shown()).toBe('staged:v1 reviewed\n'));
    store.getState().setCommitMessage('msg');
    await clickCommit();
    await waitFor(() => expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('msg'));
    expect(git(repo, 'cat-file', 'blob', 'HEAD:f')).toBe('v1 reviewed\n');
    expect(store.getState().banner).toBeNull();
    await settled(store);
  });
});

describe('Amend rewrites the commit whose message was loaded, or nothing (real panel, real git)', () => {
  const headSubject = () => git(repo, 'log', '-1', '--format=%s').trim();

  it('P4 a file is staged and Amend is checked (the editor holds the message of HEAD); HEAD is then replaced in a terminal while the staged entries stay byte-identical. The fingerprint notices (it includes HEAD) and the tick refreshes — and Amend still refuses: the loaded message belongs to the old commit. Nothing is rewritten, Amend is turned off, the text is kept', async () => {
    writeFileSync(join(repo, 'n'), 'new file\n');
    git(repo, 'add', 'n');
    const { app, store, timer } = mount(5);
    await waitFor(() => expect(timer.starts).toBe(1));
    // 复选框要等"有没有 HEAD"的探测回来才可用
    const checkbox = (await screen.findByRole('checkbox', { name: 'Amend last commit' })) as HTMLInputElement;
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    fireEvent.click(checkbox);
    await waitFor(() => expect(store.getState()).toMatchObject({ amend: true, commitMessage: 'init' }));

    // 终端里:只改写 HEAD 的提交信息(--only 不带路径:不带上已暂存的内容)。status 的条目一字不差。
    const entries = () => git(repo, 'status', '--porcelain=v2');
    const before = { fingerprint: await readStatusHash(app, repo), entries: entries() };
    git(repo, 'commit', '-q', '--amend', '--only', '-m', 'reworded in a terminal');
    expect(entries()).toBe(before.entries);
    expect(await readStatusHash(app, repo)).not.toBe(before.fingerprint);

    // 自动刷新的 tick 把面板更新到当前状态(列表没变,指纹变了)
    await timer.opts!.onTick();
    await waitFor(() => expect(store.getState().statusFingerprint).not.toBe(before.fingerprint));
    expect(store.getState()).toMatchObject({ amend: true, commitMessage: 'init' });

    const amend = (await screen.findByRole('button', { name: 'Amend last commit' })) as HTMLButtonElement;
    await waitFor(() => expect(amend.disabled).toBe(false));
    fireEvent.click(amend);

    await waitFor(() => expect(store.getState().banner).toEqual({ kind: 'warn', message: AMEND_HEAD_CHANGED_MESSAGE, dismissable: true }));
    expect(headSubject()).toBe('reworded in a terminal');
    expect(git(repo, 'status', '--porcelain')).toBe('A  n\n');
    expect(store.getState()).toMatchObject({ amend: false, commitMessage: 'init' });
    await waitFor(() => expect(store.getState().isLoading).toBe(false));

    // 重新勾选:载入的是现在的 HEAD 的信息,这次 Amend 改写的就是它
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    fireEvent.click(checkbox);
    await waitFor(() => expect(store.getState()).toMatchObject({ amend: true, commitMessage: 'reworded in a terminal' }));
    const again = (await screen.findByRole('button', { name: 'Amend last commit' })) as HTMLButtonElement;
    await waitFor(() => expect(again.disabled).toBe(false));
    fireEvent.click(again);
    await waitFor(() => expect(git(repo, 'status', '--porcelain')).toBe(''));
    expect(headSubject()).toBe('reworded in a terminal');
    expect(git(repo, 'show', 'HEAD:n')).toBe('new file\n');
    await settled(store);
  });
});
