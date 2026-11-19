// 真实 git:仓库让 git 去读一个"读不完"的文件(/dev/zero)或"打开就阻塞"的文件(FIFO)时,面板的每条
// git 命令仍须在正常时间内结束,而不是挂到宿主超时(30 s,每次自动刷新退避重试)。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchDiff } from '../../git/diff-fetcher';
import { gitCommit } from '../../git/git-commit';
import { readHeadMessage } from '../../git/head-meta';
import { loadNumstat } from '../../git/numstat';
import { installRepoSafetyGuard } from '../../git/repo-safety';
import { stageFile } from '../../git/stage-file';
import { readStatusHash } from '../../git/status-hash';
import { scanStatus } from '../../git/status-scanner';
import type { CoPluginApp, PluginShellExecOptions, PluginShellExecResult } from '../../sdk/types';

// 每条命令的耗时上限。正常仓库里这些命令都在几十毫秒内结束;挂住的命令由 KILL_AFTER_MS 终止
// (宿主的 30 s 超时在这里缩短,失败的用例不会拖住整套测试,也不会让读 /dev/zero 的 git 吃掉几十 GB 内存)。
const LIMIT_MS = 3_000;
const KILL_AFTER_MS = 3_500;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ENV, encoding: 'utf8' });

// 对应宿主 shell.exec / fs 的最小实现(见 repo-safety-real-git.spec.ts 的 realApp);每条命令记录耗时。
interface Timing { readonly args: string; readonly ms: number; readonly timedOut: boolean }
function realApp(timings: Timing[]): CoPluginApp {
  const exec = (cmd: string, args: readonly string[], opts: PluginShellExecOptions = {}) =>
    new Promise<PluginShellExecResult>((resolve) => {
      const started = Date.now();
      const child = spawn(cmd, [...args], { cwd: opts.cwd, env: { ...ENV, ...(opts.env ?? {}) } });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, Math.min(opts.timeoutMs ?? KILL_AFTER_MS, KILL_AFTER_MS));
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const sub = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? '';
        timings.push({ args: [cmd, ...args.slice(args.indexOf(sub))].join(' '), ms: Date.now() - started, timedOut });
        resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode: code, signal, timedOut, truncated: false });
      });
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
  return { shell: { exec }, fs: { lstat, stat, listDir } } as unknown as CoPluginApp;
}

const mkfifo = (p: string) => execFileSync('mkfifo', [p]);

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(realpathSync(tmpdir()), 'cgv-ufr-'));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'f.txt'), 'one\n');
  writeFileSync(join(repo, 'g.txt'), 'g\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init message');
  appendFileSync(join(repo, 'f.txt'), 'two\n');
  writeFileSync(join(repo, 'g.txt'), 'g2\n');
  git(repo, 'add', 'g.txt');
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const slow = (timings: readonly Timing[]) => timings.filter((t) => t.ms >= LIMIT_MS || t.timedOut);

/** 打开面板的完整流程:受限检测 → 指纹 → 列表(status + numstat)→ 两种 diff → HEAD 提交信息;再暂存并提交。 */
async function panelFlow() {
  const timings: Timing[] = [];
  const app = realApp(timings);
  const { guard } = installRepoSafetyGuard(app);
  expect(await guard.check(repo, { fresh: true })).toEqual({ kind: 'trusted' });
  expect(await readStatusHash(app, repo)).toContain('f.txt');
  const changes = await scanStatus(app, repo);
  expect(changes.map((c) => [c.path, c.statusX, c.statusY, c.kind])).toEqual([['f.txt', ' ', 'M', 'text'], ['g.txt', 'M', ' ', 'text']]);
  const numstat = await loadNumstat(app, repo);
  expect([...numstat]).toEqual([['f.txt', { isBinary: false, add: 1, del: 0 }], ['g.txt', { isBinary: false, add: 1, del: 1 }]]);
  const changed = await fetchDiff(app, repo, changes[0]!, 'changed');
  expect(changed).toMatchObject({ ok: true, modified: 'one\ntwo\n' });
  expect(changed.ok && changed.unifiedDiff).toContain('+two');
  const staged = await fetchDiff(app, repo, changes[1]!, 'staged');
  expect(staged).toMatchObject({ ok: true, modified: 'g2\n' });
  expect(staged.ok && staged.unifiedDiff).toContain('+g2');
  expect(await readHeadMessage(app, repo)).toBe('init message');
  expect((await stageFile(app, repo, 'f.txt')).ok).toBe(true);
  expect(await gitCommit(app, repo, 'second')).toMatchObject({ ok: true });
  expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('second');
  expect(await readHeadMessage(app, repo)).toBe('second');
  expect(slow(timings)).toEqual([]);
  return timings;
}

describe('files named by repository config: git never reads them (real git)', () => {
  it('UF1 [diff] orderFile = /dev/zero: status, numstat, both diffs, log and commit finish in normal time with correct results', async () => {
    git(repo, 'config', 'diff.orderFile', '/dev/zero');
    await panelFlow();
  });

  it('UF2 [diff] orderFile = a FIFO inside the repository: no command blocks opening it', async () => {
    mkfifo(join(repo, '.git', 'order'));
    git(repo, 'config', 'diff.orderFile', join(repo, '.git', 'order'));
    await panelFlow();
  });

  it.each([
    ['mailmap.file = /dev/zero', () => git(repo, 'config', 'mailmap.file', '/dev/zero')],
    ['mailmap.file = a FIFO', () => { mkfifo(join(repo, '.git', 'mm')); git(repo, 'config', 'mailmap.file', join(repo, '.git', 'mm')); }],
    ['a FIFO named .mailmap at the top of the working tree', () => mkfifo(join(repo, '.mailmap'))],
  ])('UF3 %s: reading the HEAD message (amend prefill, post-commit summary) finishes in normal time', async (_label, plant) => {
    plant();
    const timings: Timing[] = [];
    const app = realApp(timings);
    expect(await readHeadMessage(app, repo)).toBe('init message');
    git(repo, 'add', 'f.txt');
    expect(await gitCommit(app, repo, 'second')).toMatchObject({ ok: true });
    expect(await readHeadMessage(app, repo)).toBe('second');
    expect(slow(timings)).toEqual([]);
  });
});
