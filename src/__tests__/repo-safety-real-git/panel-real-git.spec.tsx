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
import { AMEND_HEAD_CHANGED_MESSAGE, REPO_CHANGED_MESSAGE, VIEW_REFRESHED_MESSAGE, VIEW_REFRESHING_MESSAGE } from '../../panel/CommitEditor';
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

// 可控的时序(不靠真实时间):非 null 时,每次 exec 发起时问它一次;它返回 promise 的那次调用,进程照常跑完,
// 但结果要等这个 promise 兑现才交还给插件——"这次读取还在 await"的状态可以保持任意久。
let holdExec: ((args: readonly string[]) => Promise<void> | undefined) | null = null;
// 非 null 时,它返回结果的那次调用不起进程、直接得到这个结果(模拟宿主报告的超时)。
let stubExec: ((args: readonly string[]) => PluginShellExecResult | undefined) | null = null;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

// 对应宿主 shell.exec / fs.lstat 的最小实现(见 repo-safety-real-git.spec.ts 的 realApp)
function realApp(intervalSec: number): CoPluginApp {
  const exec = async (cmd: string, args: readonly string[], opts: PluginShellExecOptions = {}) => {
    const stubbed = stubExec?.(args);
    if (stubbed) return stubbed;
    const held = holdExec?.(args);
    const result = await run(cmd, args, opts);
    await held;
    return result;
  };
  const run = (cmd: string, args: readonly string[], opts: PluginShellExecOptions = {}) =>
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
  holdExec = null;
  stubExec = null;
  cleanup();
  rmSync(repo, { recursive: true, force: true });
});

// 与 main.ts 的 load 相同的顺序:先指纹,后列表
function mount(intervalSec: number) {
  const app = realApp(intervalSec);
  const store = createGitStore({
    load: async () => {
      // 指纹读不到 → statusError(与 main.ts 相同)
      let statusFingerprint: string | null = null;
      let fingerprintError: string | null = null;
      try {
        statusFingerprint = await readStatusHash(app, repo);
      } catch (err) {
        fingerprintError = err instanceof Error ? err.message : String(err);
      }
      const changes = await scanStatus(app, repo);
      return { repoRoot: repo, changes, statusFingerprint, ...(fingerprintError !== null ? { statusError: fingerprintError } : {}) };
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
    // 选中的 Staged 行的 diff 在 refresh 之后重读;它到达之前点 Amend 得到的是"仍在刷新"(T35),不是这里要看的
    await waitFor(() => expect(store.getState()).toMatchObject({ isLoading: false, diffRefreshingKey: null }));

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
    await waitFor(() => expect(store.getState()).toMatchObject({ isLoading: false, diffRefreshingKey: null }));
    fireEvent.click(again);
    await waitFor(() => expect(git(repo, 'status', '--porcelain')).toBe(''));
    expect(headSubject()).toBe('reworded in a terminal');
    expect(git(repo, 'show', 'HEAD:n')).toBe('new file\n');
    await settled(store);
  });
});

// F1:提交前的比较以**点击时**屏幕上的内容为基线。此前基线在读完当前指纹之后才从 store 取——在途的 refresh 在
// 那次 await 期间落盘,store 与仓库都是新的,比较必然通过(复核者按真实时间扫描,+60/+100 ms 档:点击时屏幕
// 是 v1,提交了 v2 / 提交里多了 secret.env)。这里用 holdExec 把"读当前指纹"的 await 撑住,不靠时间。
describe('a commit takes what was on screen at the click, or nothing — a refresh landing mid-click does not slip new content in (real panel, real git)', () => {
  const rows = () => [...document.querySelectorAll('.cgv-path')].map((el) => el.textContent);
  const commitButton = () => screen.getByRole('button', { name: 'Commit staged changes' }) as HTMLButtonElement;
  const isFingerprintRead = (args: readonly string[]) => args.includes('--porcelain=v2');
  const terminal = {
    content: () => { writeFileSync(join(repo, 'f'), 'v2 UNREVIEWED\n'); git(repo, 'add', 'f'); },
    newfile: () => { writeFileSync(join(repo, 'secret.env'), 'TOKEN=1\n'); git(repo, 'add', 'secret.env'); },
  };

  it.each(['content', 'newfile'] as const)(
    'P5 (%s) v1 is shown; a terminal stages something else; Commit is clicked; while its fingerprint read is still in flight the auto-refresh tick lands the new list — nothing is committed, the panel says the view was refreshed after the click; the next click commits what is now shown',
    async (kind) => {
      writeFileSync(join(repo, 'f'), 'v1 reviewed\n');
      git(repo, 'add', 'f');
      const { store, timer, shown } = mount(5);
      await waitFor(() => expect(timer.starts).toBe(1));
      await waitFor(() => expect(shown()).toBe('staged:v1 reviewed\n'));
      store.getState().setCommitMessage('msg');
      await waitFor(() => expect(commitButton().disabled).toBe(false));

      terminal[kind]();
      // 点击:屏幕上仍是 v1 / 只有 f。提交前的指纹读取(读到的已是新状态)被撑住
      const gate = deferred();
      let reads = 0;
      holdExec = (args) => (isFingerprintRead(args) && reads++ === 0 ? gate.promise : undefined);
      expect(rows()).toEqual(['f']);
      fireEvent.click(commitButton());
      await waitFor(() => expect(reads).toBe(1));

      // 这期间自动刷新的 tick 发现变化,refresh 落盘:store 与仓库都是新的
      await timer.opts!.onTick();
      await waitFor(() => expect(store.getState().isLoading).toBe(false));
      if (kind === 'content') await waitFor(() => expect(shown()).toBe('staged:v2 UNREVIEWED\n'));
      else expect(rows()).toEqual(['f', 'secret.env']);
      expect(await readStatusHash(realApp(0), repo)).toBe(store.getState().statusFingerprint);

      gate.resolve();
      await waitFor(() => expect(store.getState().banner).toEqual({ kind: 'warn', message: VIEW_REFRESHED_MESSAGE, dismissable: true }));
      await waitFor(() => expect(commitButton().textContent).toBe('Commit'));
      expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('init');
      expect(store.getState().commitMessage).toBe('msg');

      // 用户看过新内容后再点:提交的就是屏幕上的
      holdExec = null;
      await waitFor(() => expect(store.getState().diffRefreshingKey).toBeNull());
      fireEvent.click(commitButton());
      await waitFor(() => expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('msg'));
      expect(git(repo, 'show', '--format=', '--name-only', 'HEAD').trim().split('\n')).toEqual(kind === 'content' ? ['f'] : ['f', 'secret.env']);
      expect(git(repo, 'cat-file', 'blob', 'HEAD:f')).toBe(kind === 'content' ? 'v2 UNREVIEWED\n' : 'v1 reviewed\n');
      await settled(store);
    },
  );

  it('P6 a refresh is already in flight at the click (the screen still shows v1, the terminal staged v2): nothing is committed, the panel asks to wait; once the refresh has landed the click commits what is shown', async () => {
    writeFileSync(join(repo, 'f'), 'v1 reviewed\n');
    git(repo, 'add', 'f');
    const { store, shown } = mount(0);
    await waitFor(() => expect(shown()).toBe('staged:v1 reviewed\n'));
    await waitFor(() => expect(store.getState().isLoading).toBe(false));
    store.getState().setCommitMessage('msg');
    await waitFor(() => expect(commitButton().disabled).toBe(false));

    terminal.content();
    // refresh 在途:它读列表的那一步被撑住
    const gate = deferred();
    let held = 0;
    holdExec = (args) => (args.includes('--porcelain=v1') && held++ === 0 ? gate.promise : undefined);
    const refreshing = store.getState().refresh();
    await waitFor(() => expect(held).toBe(1));
    expect(shown()).toBe('staged:v1 reviewed\n');
    fireEvent.click(commitButton());
    await waitFor(() => expect(store.getState().banner).toEqual({ kind: 'warn', message: VIEW_REFRESHING_MESSAGE, dismissable: true }));

    gate.resolve();
    await refreshing;
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('init');
    await waitFor(() => expect(shown()).toBe('staged:v2 UNREVIEWED\n'));
    await waitFor(() => expect(store.getState().diffRefreshingKey).toBeNull());

    fireEvent.click(commitButton());
    await waitFor(() => expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('msg'));
    expect(git(repo, 'cat-file', 'blob', 'HEAD:f')).toBe('v2 UNREVIEWED\n');
    await settled(store);
  });
});

// F4:指纹读不到(status 超时)不是"仓库变了"。此前指纹读取 5 s 超时、失败后静默记成 null:列表照常显示,
// 每次点 Commit 都提示"仓库已变化"并刷新,再读还是超时——永远提交不了,文案还是错的。
describe('a fingerprint that cannot be read is reported as such, and recovers by itself (real panel, real git)', () => {
  const timedOut: PluginShellExecResult = { stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM', timedOut: true, truncated: false };
  const commitButton = () => screen.getByRole('button', { name: 'Commit staged changes' }) as HTMLButtonElement;

  it('P7 the fingerprint status times out while the list status still answers: the panel shows the list, says the status could not be read (with the reason) and disables Commit; when status answers again the next tick clears it and the commit goes through', async () => {
    writeFileSync(join(repo, 'f'), 'v1 reviewed\n');
    git(repo, 'add', 'f');
    stubExec = (args) => (args.includes('--porcelain=v2') ? timedOut : undefined);
    const { store, timer } = mount(5);
    await waitFor(() => expect(timer.starts).toBe(1));
    await waitFor(() => expect(store.getState()).toMatchObject({ isLoading: false, statusError: 'git status failed (timed out)', statusFingerprint: null }));
    expect([...document.querySelectorAll('.cgv-path')].map((el) => el.textContent)).toEqual(['f']);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not read the repository status: git status failed (timed out). Commit and Amend are disabled until a refresh succeeds.',
    );
    store.getState().setCommitMessage('msg');
    expect(commitButton().disabled).toBe(true);

    // 仍然超时:tick 重试,状态不变
    await timer.opts!.onTick();
    expect(store.getState().statusError).toBe('git status failed (timed out)');

    // status 恢复:下一个该重试的 tick 清除错误(退避:上一次失败后隔一个 tick)
    stubExec = null;
    await timer.opts!.onTick();
    await timer.opts!.onTick();
    await waitFor(() => expect(store.getState()).toMatchObject({ isLoading: false, statusError: null }));
    expect(store.getState().statusFingerprint).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    await waitFor(() => expect(store.getState().diffRefreshingKey).toBeNull());
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    fireEvent.click(commitButton());
    await waitFor(() => expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('msg'));
    await settled(store);
  });

  it('P8 the fingerprint cannot be read at the moment of the click (the view itself is fine): nothing is committed and the panel says the state could not be confirmed — not that the repository changed', async () => {
    writeFileSync(join(repo, 'f'), 'v1 reviewed\n');
    git(repo, 'add', 'f');
    const { store } = mount(0);
    await waitFor(() => expect(store.getState()).toMatchObject({ isLoading: false, statusError: null }));
    await waitFor(() => expect(store.getState().diffCache.size).toBe(1));
    store.getState().setCommitMessage('msg');
    await waitFor(() => expect(commitButton().disabled).toBe(false));

    // 只有这一次读取超时;随后的 refresh 正常
    let failed = 0;
    stubExec = (args) => (args.includes('--porcelain=v2') && failed++ === 0 ? timedOut : undefined);
    fireEvent.click(commitButton());
    await waitFor(() => expect(store.getState().banner).toEqual({
      kind: 'warn',
      message: 'Could not confirm the current state of the repository (git status failed (timed out)). Nothing was committed — try again once the view has refreshed.',
      dismissable: true,
    }));
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('init');
    expect(store.getState()).toMatchObject({ statusError: null, commitMessage: 'msg' });

    await waitFor(() => expect(store.getState()).toMatchObject({ isLoading: false, diffRefreshingKey: null }));
    await waitFor(() => expect(commitButton().textContent).toBe('Commit'));
    fireEvent.click(commitButton());
    await waitFor(() => expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('msg'));
    await settled(store);
  });
});
