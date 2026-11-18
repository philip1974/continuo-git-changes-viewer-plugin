// 真实 git 集成:构造含恶意 .git/config 的临时仓库,每个可执行配置指向一个"写标记文件"的脚本,
// 断言插件的 git 调用不再触发任何标记;同时验证普通仓库功能与用户 hooks 不受影响。
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, readFileSync, renameSync, mkdtempSync, readdirSync, rmSync, writeFileSync, appendFileSync, statSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchDiff, FILE_READ_TIMEOUT_MS, isWorktreeDiffStale, MAX_FILE_BYTES } from '../../git/diff-fetcher';
import { DIRECTORY_DISCARD_ERROR, discardFile, parentNotDirectoryDiscardError, SUBMODULE_DISCARD_ERROR } from '../../git/discard-file';
import { UNVERIFIED_PATH_ERROR } from '../../git/worktree-entry';
import { discardHunk } from '../../git/discard-hunk';
import { DISABLED_HOOKS_PATH, gitExec, KNOWN_HOOK_EVENTS, LITERAL_ARGV_CONFIG } from '../../git/exec';
import { detectRepoHooks } from '../../git/repo-hooks';
import { stageHunk } from '../../git/stage-hunk';
import { extractHunkPatchFromUnifiedDiff, NON_UTF8_HUNK_NOTE } from '../../git/hunk-patch';
import { canDiscardFile } from '../../git/can-discard-file';
import { canStageFile } from '../../git/can-stage-file';
import { canUnstageFile } from '../../git/can-unstage-file';
import { PINNED_OUTPUT_CONFIG } from '../../git/exec';
import { _resetRestoreCache, DIRECTORY_UNSTAGE_ERROR, unstageFile } from '../../git/unstage-file';
import { unstageHunk } from '../../git/unstage-hunk';
import { gitCommit, readLastCommitSubject } from '../../git/git-commit';
import { hasHeadCommit, readHeadMessage, readHeadSha } from '../../git/head-meta';
import { installRepoSafetyGuard, isKnownSafeConfigKey, isRepoControlledScope, isUnsafeConfigEntry, parseScopedConfigListStrict, PROBE_ARGS, probeRepoSafety } from '../../git/repo-safety';
import { detectRepo } from '../../git/repo-detect';
import { readStatusHash } from '../../git/status-hash';
import { DIRECTORY_STAGE_ERROR, stageFile } from '../../git/stage-file';
import { DiffView } from '../../panel/DiffView';
import { createGitStore } from '../../state/git-store';
import { parsePorcelainStatus, scanStatus, StatusUnavailableError, UnsafeIndexError } from '../../git/status-scanner';
import type { CoPluginApp, PluginShellExecOptions, PluginShellExecResult } from '../../sdk/types';
import { keyPatterns, overlappingKeys, REVIEWED_OVERLAP } from '../repo-safety/key-overlap';

// 宿主 shell.exec 不带 maxOutputBytes 时的默认输出上限(Continuo electron/main/services/shell.service.ts:
// DEFAULT_MAX_OUTPUT_BYTES)。
const HOST_DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// 最小 app.shell / app.fs 实现(对应宿主 shell.exec:env 合并进进程 env;stdout / stderr 各自按字节封顶,
// 超出部分丢弃并置 truncated,进程照常跑完)
function realApp(): CoPluginApp {
  const exec = (cmd: string, args: readonly string[], opts: PluginShellExecOptions = {}) =>
    new Promise<PluginShellExecResult>((resolve) => {
      const child = spawn(cmd, [...args], {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
      });
      const max = opts.maxOutputBytes ?? HOST_DEFAULT_MAX_OUTPUT_BYTES;
      let truncated = false;
      const capped = () => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        return {
          push: (d: Buffer) => {
            const room = max - bytes;
            if (d.length > room) truncated = true;
            if (room > 0) chunks.push(d.subarray(0, room));
            bytes += Math.min(d.length, Math.max(room, 0));
          },
          text: () => Buffer.concat(chunks).toString('utf8'),
        };
      };
      const out = capped();
      const err = capped();
      child.stdout.on('data', out.push);
      child.stderr.on('data', err.push);
      // 宿主:到 timeoutMs 终止进程并置 timedOut(不传时宿主默认 30 s;这里不传就不设,测试自身有超时)
      let timedOut = false;
      const timer = opts.timeoutMs === undefined ? null : setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, opts.timeoutMs);
      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout: out.text(), stderr: err.text(), exitCode: code, signal, timedOut, truncated });
      });
      // 子进程不读 stdin 就退出时写端会报 EPIPE(与被测行为无关),忽略
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input ?? '');
    });
  const stat = async (p: string) => {
    const s = statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory(), isSymlink: false };
  };
  const lstat = async (p: string) => {
    const s = lstatSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink() };
  };
  const listDir = async (p: string) =>
    readdirSync(p, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
      isSymlink: e.isSymbolicLink(),
    }));
  return { shell: { exec }, fs: { stat, lstat, listDir } } as unknown as CoPluginApp;
}

// 模拟宿主 plugin-fs:scope 只含 scopeRoot;read 类(listDir/stat)先 realpath(跟随链接)再判 scope,
// lstat 只 realpath 父目录、不跟随末级;错误经 ipcRenderer.invoke 传回时只剩 message(code 丢失)。
function hostScopedApp(scopeRoot: string): CoPluginApp {
  const app = realApp();
  const root = realpathSync(scopeRoot);
  const inScope = (p: string) => p === root || p.startsWith(root + sep);
  const ipc = async <T>(channel: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new Error(`Error invoking remote method '${channel}': ${String(err)}`);
    }
  };
  const readCheck = (p: string) => {
    const canonical = realpathSync(p);
    if (!inScope(canonical)) throw new Error(`ScopeError: path is outside granted scopes`);
    return canonical;
  };
  const lstatCheck = (p: string) => {
    const full = join(realpathSync(dirname(p)), basename(p));
    if (!inScope(full)) throw new Error(`ScopeError: path is outside granted scopes`);
    return full;
  };
  return {
    ...app,
    fs: {
      listDir: (p: string) => ipc('plugin-fs:list-dir', () => app.fs.listDir(readCheck(p))),
      stat: (p: string) => ipc('plugin-fs:stat', () => app.fs.stat(readCheck(p))),
      lstat: (p: string) => ipc('plugin-fs:lstat', () => app.fs.lstat(lstatCheck(p))),
    },
  } as unknown as CoPluginApp;
}

// 去掉插件注入的 `-c core.hooksPath=/dev/null`,模拟"未加防护"的插件:用于证明 fixture 的 hooks 确实会被触发
function unprotectedApp(): CoPluginApp {
  const app = realApp();
  const exec = app.shell.exec.bind(app.shell);
  const strip = (args: readonly string[]) => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' && args[i + 1] === `core.hooksPath=${DISABLED_HOOKS_PATH}`) {
        i++;
        continue;
      }
      out.push(args[i]!);
    }
    return out;
  };
  return {
    ...app,
    shell: { exec: (cmd: string, args: readonly string[], opts?: PluginShellExecOptions) => exec(cmd, strip(args), opts) },
  } as unknown as CoPluginApp;
}

const HOOK_NAMES = ['post-index-change', 'post-checkout', 'reference-transaction', 'pre-commit', 'post-commit'];
function plantHooks(hooksDir = join(repo, '.git', 'hooks')): void {
  mkdirSync(hooksDir, { recursive: true });
  for (const h of HOOK_NAMES) {
    const p = join(hooksDir, h);
    writeFileSync(p, `#!/bin/sh\ntouch "${join(markDir, h)}"\nexit 0\n`);
    chmodSync(p, 0o755);
  }
}

let base: string;
let repo: string;
let markDir: string;
let binDir: string;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ENV, encoding: 'utf8' });
}

// 每个标记脚本:被执行即在 markDir 写 <name>,并把 stdin/参数原样透传(让 filter/textconv 仍"能用")
function marker(name: string): string {
  const p = join(binDir, name);
  writeFileSync(p, `#!/bin/sh\ntouch "${join(markDir, name)}"\nif [ $# -gt 0 ] && [ -f "$1" ]; then cat "$1"; else cat; fi\nexit 0\n`);
  chmodSync(p, 0o755);
  return p;
}
const marks = () => readdirSync(markDir).sort();
const clearMarks = () => {
  for (const f of readdirSync(markDir)) rmSync(join(markDir, f));
};

function initRepo(): void {
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'f.txt'), 'one\n');
  writeFileSync(join(repo, 'g.txt'), 'gee\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
}

// 伪造一个带 gpgsig 头的提交,使 log.showSignature 会调用 gpg.program
function makeSignedHead(): void {
  const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
  const parent = git(repo, 'rev-parse', 'HEAD').trim();
  const body =
    `tree ${tree}\nparent ${parent}\nauthor t <t@t> 1 +0000\ncommitter t <t@t> 1 +0000\n` +
    `gpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n`;
  const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, input: body, env: ENV, encoding: 'utf8' }).trim();
  git(repo, 'update-ref', 'refs/heads/main', sha);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cgv-safety-'));
  repo = join(base, 'repo');
  markDir = join(base, 'marks');
  binDir = join(base, 'bin');
  for (const d of [repo, markDir, binDir]) mkdirSync(d);
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  initRepo();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  delete process.env.GIT_WORK_TREE;
});

// stat-dirty 但内容相同 → status 必须重新哈希(触发 clean filter);g.txt 有真实改动 → diff 会走 textconv/ext
function dirty(dir = repo, file = 'f.txt'): void {
  utimesSync(join(dir, file), new Date(1_000_000_000_000), new Date(1_000_000_000_000));
}

async function runEverything(app: CoPluginApp): Promise<void> {
  dirty();
  appendFileSync(join(repo, 'g.txt'), 'more\n');
  // 受限仓库里守卫拒绝 status(scanStatus 抛 StatusUnavailableError,不再返回空列表):其余命令照常尝试
  const changes = await scanStatus(app, repo).catch((err: unknown) => {
    if (err instanceof StatusUnavailableError) return [];
    throw err;
  });
  await readStatusHash(app, repo).catch(() => '');
  await fetchDiff(app, repo, changes[0] ?? { path: 'f.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' });
  await readHeadMessage(app, repo);
  await hasHeadCommit(app, repo);
}

// 每个写操作:准备状态 → 运行 → 返回触发的 hook 标记
const WRITE_OPS: ReadonlyArray<readonly [string, (app: CoPluginApp) => Promise<{ ok: boolean }>]> = [
  ['stageFile (git add)', async (app) => {
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    clearMarks();
    return stageFile(app, repo, 'f.txt');
  }],
  ['unstageFile (git restore --staged)', async (app) => {
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    git(repo, 'add', 'f.txt');
    clearMarks();
    _resetRestoreCache();
    return unstageFile(app, repo, 'f.txt');
  }],
  ['unstage fallback (git reset HEAD --)', async (app) => {
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    git(repo, 'add', 'f.txt');
    clearMarks();
    const r = await gitExec(app, repo, ['reset', 'HEAD', '--', 'f.txt']);
    return { ok: r.exitCode === 0 };
  }],
  ['stageHunk (git apply --cached)', async (app) => {
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    const patch = git(repo, 'diff');
    clearMarks();
    return stageHunk(app, repo, patch);
  }],
  ['unstageHunk (git apply --cached --reverse)', async (app) => {
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    git(repo, 'add', 'f.txt');
    const patch = git(repo, 'diff', '--cached');
    clearMarks();
    return unstageHunk(app, repo, patch);
  }],
  ['discardHunk (git apply --reverse)', async (app) => {
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    const patch = git(repo, 'diff');
    clearMarks();
    return discardHunk(app, repo, patch);
  }],
  ['discardFile (git checkout --)', async (app) => {
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    clearMarks();
    return discardFile(app, repo, 'f.txt');
  }],
];

describe('repo safety against a real git with a hostile .git/config', () => {
  it('R1 baseline sanity: without the plugin hardening the hostile config does execute (proves the fixture)', () => {
    git(repo, 'config', 'filter.x.clean', marker('clean'));
    writeFileSync(join(repo, '.gitattributes'), '* filter=x\n');
    dirty();
    git(repo, '--no-optional-locks', 'status', '--porcelain');
    expect(marks()).toContain('clean');
  });

  it('R2 filter/textconv/diff.external/gpg/fsmonitor in local config: guarded plugin runs nothing and reports restricted', async () => {
    git(repo, 'config', 'filter.x.clean', marker('clean'));
    git(repo, 'config', 'filter.x.smudge', marker('smudge'));
    git(repo, 'config', 'diff.x.textconv', marker('textconv'));
    git(repo, 'config', 'diff.external', marker('ext'));
    git(repo, 'config', 'gpg.program', marker('gpg'));
    git(repo, 'config', 'log.showSignature', 'true');
    git(repo, 'config', 'core.fsmonitor', marker('fsmonitor'));
    writeFileSync(join(repo, '.gitattributes'), '* filter=x diff=x\n');
    makeSignedHead();

    clearMarks();
    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    const verdict = await guard.check(repo, { fresh: true });
    expect(verdict.kind).toBe('restricted');

    await runEverything(app);
    writeFileSync(join(repo, 'new.txt'), 'n\n');
    expect((await stageFile(app, repo, 'new.txt')).ok).toBe(false);
    expect((await gitCommit(app, repo, 'msg')).ok).toBe(false);

    expect(marks()).toEqual([]);
  });

  it('R3 executable settings pulled in through include.path are detected', async () => {
    writeFileSync(join(repo, 'evil.cfg'), `[filter "x"]\n\tclean = ${marker('clean')}\n`);
    git(repo, 'config', 'include.path', '../evil.cfg');
    writeFileSync(join(repo, '.gitattributes'), '* filter=x\n');

    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    const verdict = await guard.check(repo);
    expect(verdict).toMatchObject({ kind: 'restricted', keys: ['filter.x.clean'] });
    await runEverything(app);
    expect(marks()).toEqual([]);
  });

  it('R4 hardened argv alone neutralizes textconv / diff.external / showSignature / fsmonitor and diff still works', async () => {
    git(repo, 'config', 'diff.x.textconv', marker('textconv'));
    git(repo, 'config', 'diff.external', marker('ext'));
    git(repo, 'config', 'gpg.program', marker('gpg'));
    git(repo, 'config', 'log.showSignature', 'true');
    git(repo, 'config', 'core.fsmonitor', marker('fsmonitor'));
    writeFileSync(join(repo, '.gitattributes'), '* diff=x\n');
    git(repo, 'add', '.gitattributes');
    git(repo, 'commit', '-qm', 'attrs');
    makeSignedHead();

    clearMarks();
    const app = realApp(); // 不装守卫:只验证参数层加固
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    const changes = await scanStatus(app, repo);
    expect(changes.map((c) => c.path)).toEqual(['f.txt']);
    const diff = await fetchDiff(app, repo, changes[0]!);
    expect(diff.ok && diff.unifiedDiff).toContain('+two');
    expect(diff.ok && diff.original).toBe('one\n');
    expect(await readHeadMessage(app, repo)).toBe('signed');

    expect(marks()).toEqual([]);
  });

  it('R5 nested repository with its own hostile filter is not recursed into by status/diff', async () => {
    const sub = join(repo, 'sub');
    mkdirSync(sub);
    git(sub, 'init', '-q');
    writeFileSync(join(sub, 's.txt'), 's\n');
    writeFileSync(join(sub, '.gitattributes'), '* filter=x\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-qm', 's');
    git(sub, 'config', 'filter.x.clean', marker('clean'));
    git(repo, 'add', 'sub');
    git(repo, 'commit', '-qm', 'gitlink');
    dirty(sub, 's.txt');
    git(repo, '--no-optional-locks', 'status', '--porcelain');
    expect(marks()).toContain('clean'); // fixture 生效:未加固时 status 会递归进嵌套仓库
    clearMarks();

    const app = realApp();
    installRepoSafetyGuard(app);
    await runEverything(app);

    expect(marks()).toEqual([]);
  });

  it('R6 ordinary repository keeps working: status, diff, stage, commit, and user hooks still run', async () => {
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch "${join(markDir, 'pre-commit')}"\nexit 0\n`);
    chmodSync(hook, 0o755);

    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect((await guard.check(repo)).kind).toBe('trusted');

    appendFileSync(join(repo, 'f.txt'), 'two\n');
    const changes = await scanStatus(app, repo);
    expect(changes).toHaveLength(1);
    const diff = await fetchDiff(app, repo, changes[0]!);
    expect(diff.ok && diff.unifiedDiff).toContain('+two');
    expect((await stageFile(app, repo, 'f.txt')).ok).toBe(true);
    const commit = await gitCommit(app, repo, 'second');
    expect(commit).toMatchObject({ ok: true });
    expect(await readHeadMessage(app, repo)).toBe('second');

    expect(marks()).toEqual(['pre-commit']);
    expect(existsSync(join(repo, '.git', 'index'))).toBe(true);
  });

  it('R7 baseline: without the hooksPath override, stage / unstage / discard run planted .git/hooks (proves the fixture)', async () => {
    plantHooks();
    const app = unprotectedApp();
    installRepoSafetyGuard(app);
    const fired: Record<string, string[]> = {};
    for (const [name, op] of WRITE_OPS) {
      git(repo, 'reset', '-q', '--hard');
      expect((await op(app)).ok).toBe(true);
      fired[name] = marks();
    }
    expect(fired['stageFile (git add)']).toContain('post-index-change');
    expect(fired['unstageFile (git restore --staged)']).toContain('post-index-change');
    expect(fired['unstage fallback (git reset HEAD --)']).toContain('post-index-change');
    expect(fired['stageHunk (git apply --cached)']).toContain('post-index-change');
    expect(fired['unstageHunk (git apply --cached --reverse)']).toContain('post-index-change');
    expect(fired['discardFile (git checkout --)']).toContain('post-checkout');
  });

  it('R8 planted .git/hooks in a trusted-config repo: plugin stage / unstage / discard / refresh run no hook', async () => {
    plantHooks();
    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect((await guard.check(repo, { fresh: true })).kind).toBe('trusted');
    for (const [name, op] of WRITE_OPS) {
      git(repo, 'reset', '-q', '--hard');
      expect({ name, ok: (await op(app)).ok }).toEqual({ name, ok: true });
      expect({ name, marks: marks() }).toEqual({ name, marks: [] });
    }
    clearMarks();
    await runEverything(app);
    expect(marks()).toEqual([]);
  });

  it('R9 detectRepoHooks: samples only → none; planted hook → present; commit still runs hooks', async () => {
    const app = realApp();
    expect(readdirSync(join(repo, '.git', 'hooks')).every((n) => n.endsWith('.sample'))).toBe(true);
    expect(await detectRepoHooks(app, repo)).toEqual({ kind: 'none' });

    rmSync(join(repo, '.git', 'hooks'), { recursive: true });
    expect(await detectRepoHooks(app, repo)).toEqual({ kind: 'none' });

    plantHooks();
    expect(await detectRepoHooks(app, repo)).toEqual({
      kind: 'present',
      hooks: [...HOOK_NAMES].sort(),
      hooksPath: null,
    });

    // 确认后的提交照常运行用户 hooks
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    git(repo, 'add', 'f.txt');
    clearMarks();
    expect(await gitCommit(app, repo, 'with hooks')).toMatchObject({ ok: true });
    expect(marks()).toEqual(expect.arrayContaining(['pre-commit', 'post-commit']));
  });

  it('R10 detectRepoHooks: local core.hooksPath → present; linked worktree sees the main repo hooks', async () => {
    const app = realApp();
    git(repo, 'config', 'core.hooksPath', '.husky');
    expect(await detectRepoHooks(app, repo)).toEqual({ kind: 'present', hooks: [], hooksPath: '.husky' });
    git(repo, 'config', '--unset', 'core.hooksPath');

    const wt = join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    expect(await detectRepoHooks(app, wt)).toEqual({ kind: 'none' });
    plantHooks();
    expect(await detectRepoHooks(app, wt)).toMatchObject({ kind: 'present', hooksPath: null });
  });

  it('R11 detectRepoHooks: core.hooksPath from global config (user-owned) → none even with .git/hooks present', async () => {
    plantHooks();
    const globalCfg = join(base, 'global.cfg');
    writeFileSync(globalCfg, `[core]\n\thooksPath = ${join(base, 'user-hooks')}\n`);
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    expect(await detectRepoHooks(realApp(), repo)).toEqual({ kind: 'none' });
  });

  it('R12 .git/hooks symlinked outside the workspace (hostile archive) → unknown under host scope; git does follow it', async () => {
    // 压缩包同时含 repo/ 与 evilhooks/pre-commit,repo/.git/hooks -> ../../evilhooks;用户以 repo/ 为 workspace
    plantHooks(join(base, 'evilhooks'));
    rmSync(join(repo, '.git', 'hooks'), { recursive: true });
    symlinkSync(join('..', '..', 'evilhooks'), join(repo, '.git', 'hooks'));

    expect(await detectRepoHooks(hostScopedApp(repo), repo)).toMatchObject({ kind: 'unknown' });
    // scope 覆盖链接目标时如实列出
    expect(await detectRepoHooks(hostScopedApp(base), repo)).toMatchObject({ kind: 'present', hooksPath: null });

    // 证明 fixture:git 跟随该链接执行 pre-commit
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    git(repo, 'add', 'f.txt');
    clearMarks();
    expect(await gitCommit(realApp(), repo, 'via link')).toMatchObject({ ok: true });
    expect(marks()).toContain('pre-commit');
  });

  it('R13 host-scoped fs: hooks dir missing → none; samples only → none', async () => {
    expect(await detectRepoHooks(hostScopedApp(repo), repo)).toEqual({ kind: 'none' });
    rmSync(join(repo, '.git', 'hooks'), { recursive: true });
    expect(await detectRepoHooks(hostScopedApp(repo), repo)).toEqual({ kind: 'none' });
  });

  it('R14 partial clone whose repo config sets protocol.file.allow=always + remote uploadpack: GIT_ALLOW_PROTOCOL="" still blocks the lazy fetch (even without GIT_NO_LAZY_FETCH)', async () => {
    const server = join(base, 'server');
    mkdirSync(server);
    git(server, 'init', '-q', '-b', 'main');
    writeFileSync(join(server, 'f.txt'), 'hi\n');
    git(server, 'add', '.');
    git(server, 'commit', '-qm', 's');
    git(server, 'config', 'uploadpack.allowFilter', 'true');
    const client = join(base, 'client');
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${server}`, client], { env: ENV });
    const up = join(binDir, 'uploadpack');
    writeFileSync(up, `#!/bin/sh\ntouch "${join(markDir, 'uploadpack')}"\nexec git-upload-pack "$@"\n`);
    chmodSync(up, 0o755);
    git(client, 'config', 'remote.origin.uploadpack', up);
    // 仓库级 protocol.<name>.allow 优先于 `-c protocol.allow=never`
    git(client, 'config', 'protocol.file.allow', 'always');

    // 去掉插件 env 中的指定变量后执行:去掉 GIT_NO_LAZY_FETCH 模拟 git < 2.45(不认该变量)
    const run = async (drop: string[]) => {
      const app = realApp();
      const exec = app.shell.exec.bind(app.shell);
      const stripped = {
        ...app,
        shell: {
          exec: (cmd: string, args: readonly string[], opts: PluginShellExecOptions = {}) => {
            const env = { ...(opts.env ?? {}) };
            for (const k of drop) delete env[k];
            return exec(cmd, args, { ...opts, env });
          },
        },
      } as unknown as CoPluginApp;
      clearMarks();
      return gitExec(stripped, client, ['show', 'HEAD:f.txt']);
    };

    // GIT_ALLOW_PROTOCOL="" 挡住惰性拉取(未拉取,blob 仍缺失,下面的对照场景不受影响)
    const blocked = await run(['GIT_NO_LAZY_FETCH']);
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr).toMatch(/transport 'file' not allowed/);
    expect(marks()).toEqual([]);

    // 证明 fixture:只剩 `-c protocol.allow=never` 时挡不住(拉取成功并执行了仓库指定的 uploadpack)
    const leaked = await run(['GIT_NO_LAZY_FETCH', 'GIT_ALLOW_PROTOCOL']);
    expect(leaked.exitCode).toBe(0);
    expect(marks()).toEqual(['uploadpack']);
  });
  // 恶意压缩包:repo/.git 为 gitfile,真实 git 目录名带首尾空白。git 读 gitfile 只去换行、保留空格
  // (`gitdir:` 后紧跟的那一个空格之外的前导空白也保留),rev-parse 输出 `<...>/gd \n`。
  it.each([
    ['trailing space', 'gd '],
    ['trailing tab', 'gd\t'],
    ['leading space', ' gd'],
  ])('R15 gitfile pointing at a git dir whose name has %s → hooks there are detected; git really runs them', async (_label, name) => {
    renameSync(join(repo, '.git'), join(repo, name));
    writeFileSync(join(repo, '.git'), `gitdir: ${name}\n`);
    plantHooks(join(repo, name, 'hooks'));
    // 去掉空白后的同名目录不存在(否则漏判不会表现为 ENOENT)
    expect(existsSync(join(repo, name.trim()))).toBe(false);

    const expected = { kind: 'present', hooks: [...HOOK_NAMES].sort(), hooksPath: null };
    expect(await detectRepoHooks(realApp(), repo)).toEqual(expected);
    expect(await detectRepoHooks(hostScopedApp(repo), repo)).toEqual(expected);

    // 证明 fixture:git 确实使用该目录并执行其中的 pre-commit
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    git(repo, 'add', 'f.txt');
    clearMarks();
    expect(await gitCommit(realApp(), repo, 'via gitfile')).toMatchObject({ ok: true });
    expect(marks()).toContain('pre-commit');
  });
});

// 重定向类向量:不执行任何程序,但让 git 把工作树 / git 目录 / 对象库解析到 workspace 之外,
// 于是 status / diff 读出外部文件内容,stage / discard / commit 写到外部。
describe('repo safety against redirection outside the workspace (real git)', () => {
  let secretDir: string;
  let priv: string;
  let victim: string;
  const SECRET = 'TOP-SECRET-FILE-CONTENT';
  const PRIVATE = 'PRIVATE-REPO-CONTENT';
  const PRIVATE_MSG = 'private commit msg';

  beforeEach(() => {
    secretDir = join(base, 'secret');
    priv = join(base, 'priv');
    victim = join(base, 'victim');
    for (const d of [secretDir, priv, victim]) mkdirSync(d);
    writeFileSync(join(secretDir, 'f.txt'), `${SECRET}\n`);
    git(priv, 'init', '-q', '-b', 'main');
    writeFileSync(join(priv, 'p.txt'), `${PRIVATE}\n`);
    git(priv, 'add', '.');
    git(priv, 'commit', '-qm', PRIVATE_MSG);
  });

  const privGit = (...p: string[]) => join(priv, '.git', ...p);
  const repoGit = (...p: string[]) => join(repo, '.git', ...p);
  const relink = (target: string, link: string) => {
    rmSync(link, { recursive: true, force: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
  };

  // 未加防护(不装守卫)时插件读到的全部文本:状态路径 + 每个变更的 diff + HEAD 提交信息
  async function everythingShown(app: CoPluginApp): Promise<string> {
    const changes = await scanStatus(app, repo).catch(() => []);
    const parts: string[] = changes.map((c) => c.path);
    for (const c of changes) {
      const d = await fetchDiff(app, repo, c).catch(() => null);
      if (d && d.ok) parts.push(d.unifiedDiff ?? '', d.original ?? '', d.modified ?? '');
    }
    parts.push((await readHeadMessage(app, repo).catch(() => '')) ?? '');
    return parts.join('\n');
  }

  async function expectRestricted(app: CoPluginApp, message: RegExp): Promise<void> {
    const { guard } = installRepoSafetyGuard(app);
    const verdict = await guard.check(repo, { fresh: true });
    expect(verdict).toMatchObject({ kind: 'restricted' });
    expect(verdict.kind === 'restricted' && verdict.message).toMatch(message);
    // 受限后任何插件 git 调用都不起进程、不出内容
    expect(await everythingShown(app)).toBe('');
    expect((await gitExec(app, repo, ['diff'])).exitCode).not.toBe(0);
    expect((await stageFile(app, repo, 'f.txt')).ok).toBe(false);
    expect((await discardFile(app, repo, 'f.txt')).ok).toBe(false);
    expect((await gitCommit(app, repo, 'msg')).ok).toBe(false);
  }

  it('R16 core.worktree pointing outside: unguarded diff shows the outside file and discard overwrites it; guarded → restricted', async () => {
    git(repo, 'config', 'core.worktree', secretDir);

    const shown = await everythingShown(realApp());
    expect(shown).toContain(SECRET);
    // 写方向:discard 把 HEAD 版本写进 workspace 外的文件
    expect((await discardFile(realApp(), repo, 'f.txt')).ok).toBe(true);
    expect(readFileSync(join(secretDir, 'f.txt'), 'utf8')).toBe('one\n');

    writeFileSync(join(secretDir, 'f.txt'), `${SECRET}\n`);
    await expectRestricted(realApp(), /core\.worktree/);
    expect(readFileSync(join(secretDir, 'f.txt'), 'utf8')).toBe(`${SECRET}\n`);
  });

  it('R17 core.worktree in config.worktree (extensions.worktreeConfig) and core.bare=true are restricted', async () => {
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    writeFileSync(repoGit('config.worktree'), `[core]\n\tworktree = ${secretDir}\n`);
    expect(await everythingShown(realApp())).toContain(SECRET);
    await expectRestricted(realApp(), /core\.worktree/);

    rmSync(repoGit('config.worktree'));
    git(repo, 'config', 'core.bare', 'true');
    await expectRestricted(realApp(), /core\.bare/);
  });

  it('R18 working tree redirected without any local key (defense in depth): layout check alone restricts', async () => {
    // 用环境变量 GIT_WORK_TREE 重定向(攻击者做不到,键检测也看不到)——只为证明布局核对独立于键检测生效
    process.env.GIT_WORK_TREE = secretDir;
    expect(await everythingShown(realApp())).toContain(SECRET);
    await expectRestricted(realApp(), /working tree/);
  });

  it('R19 .git is a gitfile pointing at another (private) repository: unguarded leaks its content; guarded → restricted', async () => {
    rmSync(repoGit(), { recursive: true });
    writeFileSync(repoGit(), `gitdir: ${privGit()}\n`);

    const shown = await everythingShown(realApp());
    expect(shown).toContain(PRIVATE);
    expect(shown).toContain(PRIVATE_MSG);

    await expectRestricted(realApp(), /git directory is outside/);
    await expectRestricted(hostScopedApp(repo), /git directory is outside/);
  });

  it('R20 .git symlinked to another repository / commondir file pointing outside → restricted', async () => {
    writeFileSync(repoGit('commondir'), `${privGit()}\n`);
    expect(await everythingShown(realApp())).toContain(PRIVATE_MSG);
    await expectRestricted(realApp(), /git directory is outside/);

    rmSync(repoGit(), { recursive: true });
    symlinkSync(privGit(), repoGit());
    expect(await everythingShown(realApp())).toContain(PRIVATE);
    await expectRestricted(realApp(), /git directory is outside/);
  });

  it('R21 .git/index symlinked to another repository index + alternates: unguarded leaks; stage overwrites the outside index; guarded → restricted', async () => {
    relink(privGit('index'), repoGit('index'));
    writeFileSync(repoGit('objects', 'info', 'alternates'), `${privGit('objects')}\n`);
    expect(await everythingShown(realApp())).toContain(PRIVATE);

    const before = readFileSync(privGit('index'));
    await expectRestricted(realApp(), /symbolic link \(index\)/);
    await expectRestricted(hostScopedApp(repo), /symbolic link \(index\)/);
    expect(readFileSync(privGit('index')).equals(before)).toBe(true);

    // 证明写方向:未加防护时 stage 经符号链接改写外部 index
    writeFileSync(join(repo, 'new.txt'), 'n\n');
    expect((await stageFile(realApp(), repo, 'new.txt')).ok).toBe(true);
    expect(readFileSync(privGit('index')).equals(before)).toBe(false);
  });

  it('R22 deep ref symlink + object fan-out symlinks (no alternates, top-level entries all regular): unguarded leaks; guarded → restricted', async () => {
    relink(privGit('refs', 'heads', 'main'), repoGit('refs', 'heads', 'main'));
    for (const e of readdirSync(repoGit('objects'))) {
      if (/^[0-9a-f]{2}$/.test(e)) rmSync(repoGit('objects', e), { recursive: true });
    }
    for (const e of readdirSync(privGit('objects'))) {
      if (/^[0-9a-f]{2}$/.test(e)) symlinkSync(privGit('objects', e), repoGit('objects', e));
    }
    const shown = await everythingShown(realApp());
    expect(shown).toContain(PRIVATE_MSG);
    expect(shown).toContain(PRIVATE);

    await expectRestricted(realApp(), /symbolic link \((objects|refs)\//);
    await expectRestricted(hostScopedApp(repo), /symbolic link \((objects|refs)\//);
  });

  it('R23 deep ref symlink + objects/info/alternates: unguarded leaks; alternates alone is already restricted', async () => {
    writeFileSync(repoGit('objects', 'info', 'alternates'), `${privGit('objects')}\n`);
    // 只有 alternates:攻击者不知道私有对象的 OID,引用不到 → 不泄露
    const alone = await everythingShown(realApp());
    expect(alone).not.toContain(PRIVATE);
    expect(alone).not.toContain(PRIVATE_MSG);
    await expectRestricted(realApp(), /alternates/);

    // 加一个深层 ref 符号链接即可拿到 OID
    relink(privGit('refs', 'heads', 'main'), repoGit('refs', 'heads', 'main'));
    expect(await everythingShown(realApp())).toContain(PRIVATE_MSG);
    await expectRestricted(realApp(), /alternates|symbolic link/);
  });

  it('R24 reflog symlinked outside (logs/HEAD, deep logs/refs/heads/main): unguarded commit appends attacker-controlled identity to the outside files; guarded → restricted', async () => {
    const rc = join(victim, 'zshrc');
    const rc2 = join(victim, 'rc2');
    writeFileSync(rc, '# rc\n');
    writeFileSync(rc2, '# rc2\n');
    git(repo, 'config', 'user.name', 'x $(touch /tmp/pwned) y');
    git(repo, 'config', 'user.email', 'a@b');
    relink(rc2, repoGit('logs', 'refs', 'heads', 'main'));

    // 只有深层链接(顶层条目全是普通文件 / 目录)也要拦住
    await expectRestricted(realApp(), /symbolic link \(logs\/refs\/heads\/main\)/);
    relink(rc, repoGit('logs', 'HEAD'));
    await expectRestricted(hostScopedApp(repo), /symbolic link \(logs\//);
    expect(readFileSync(rc, 'utf8')).toBe('# rc\n');
    expect(readFileSync(rc2, 'utf8')).toBe('# rc2\n');

    appendFileSync(join(repo, 'f.txt'), 'two\n');
    git(repo, 'add', 'f.txt');
    expect(await gitCommit(realApp(), repo, 'msg')).toMatchObject({ ok: true });
    expect(readFileSync(rc, 'utf8')).toContain('$(touch /tmp/pwned)');
    expect(readFileSync(rc2, 'utf8')).toContain('$(touch /tmp/pwned)');
  });

  it('R25 .git/config symlinked outside → restricted even when the target config is harmless', async () => {
    const ext = join(victim, 'gitconfig');
    renameSync(repoGit('config'), ext);
    symlinkSync(ext, repoGit('config'));
    await expectRestricted(realApp(), /symbolic link \(config\)/);
  });

  it('R25b .git/COMMIT_EDITMSG symlinked outside: unguarded commit overwrites the outside file; guarded → restricted', async () => {
    const precious = join(victim, 'precious');
    writeFileSync(precious, 'precious\n');
    relink(precious, repoGit('COMMIT_EDITMSG'));
    await expectRestricted(hostScopedApp(repo), /symbolic link \(COMMIT_EDITMSG\)/);
    expect(readFileSync(precious, 'utf8')).toBe('precious\n');

    appendFileSync(join(repo, 'f.txt'), 'two\n');
    git(repo, 'add', 'f.txt');
    expect(await gitCommit(realApp(), repo, 'typed message')).toMatchObject({ ok: true });
    expect(readFileSync(precious, 'utf8')).toContain('typed message');
  });

  it('R26 file access unavailable or denied → restricted (the git directory cannot be inspected)', async () => {
    const noFs = { shell: realApp().shell } as unknown as CoPluginApp;
    await expectRestricted(noFs, /could not be inspected/);
    // 宿主 scope 不含本仓库(未授权)
    await expectRestricted(hostScopedApp(victim), /could not be inspected/);
  });

  it('R27 legitimate layouts that stay trusted: plain repo (host-scoped, non-canonical tmp path), in-workspace separate git dir, hooks symlink, main repo owning a linked worktree, empty alternates', async () => {
    const trusted = async (app: CoPluginApp, dir: string) => {
      const { guard } = installRepoSafetyGuard(app);
      expect(await guard.check(dir, { fresh: true })).toEqual({ kind: 'trusted' });
    };
    await trusted(realApp(), repo);
    await trusted(hostScopedApp(repo), repo);

    // hooks 目录是符号链接(常见做法,由 repo-hooks 在提交前处理);空的 alternates 文件
    mkdirSync(join(repo, 'scripts'));
    relink(join('..', 'scripts'), repoGit('hooks'));
    writeFileSync(repoGit('objects', 'info', 'alternates'), '');
    await trusted(hostScopedApp(repo), repo);
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    const app = hostScopedApp(repo);
    installRepoSafetyGuard(app);
    expect((await scanStatus(app, repo)).map((c) => c.path)).toEqual(['f.txt']);

    // git init --separate-git-dir 到 workspace 内
    const sep1 = join(base, 'sep');
    mkdirSync(sep1);
    git(sep1, 'init', '-q', '-b', 'main', '--separate-git-dir', join(sep1, 'gd'));
    expect(lstatSync(join(sep1, '.git')).isFile()).toBe(true);
    await trusted(hostScopedApp(sep1), sep1);

    // 主仓库在 workspace 内的 linked worktree(workspace = 主仓库,其下再挂一个 worktree)不影响主仓库
    mkdirSync(join(base, 'm'));
    git(join(base, 'm'), 'init', '-q', '-b', 'main');
    git(join(base, 'm'), 'commit', '-q', '--allow-empty', '-m', 'i');
    git(join(base, 'm'), 'worktree', 'add', '-q', '-b', 'side', join(base, 'm', 'wt'));
    await trusted(hostScopedApp(join(base, 'm')), join(base, 'm'));
  });

  it('R28 legitimate layouts that become restricted (documented trade-off): linked worktree / submodule whose git dir is outside the workspace, bare repo, subfolder of a repo', async () => {
    const restricted = async (dir: string, message: RegExp) => {
      const { guard } = installRepoSafetyGuard(hostScopedApp(dir));
      const v = await guard.check(dir, { fresh: true });
      expect({ dir, kind: v.kind }).toEqual({ dir, kind: 'restricted' });
      expect(v.kind === 'restricted' && v.message).toMatch(message);
    };
    const wt = join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    await restricted(wt, /git directory is outside/);

    const sup = join(base, 'super');
    mkdirSync(sup);
    git(sup, 'init', '-q', '-b', 'main');
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', repo, 'sub');
    await restricted(join(sup, 'sub'), /core\.worktree|git directory is outside/);

    const bare = join(base, 'bare.git');
    git(base, 'init', '-q', '--bare', bare);
    await restricted(bare, /core\.bare|working tree/);

    mkdirSync(join(repo, 'pkg'));
    await restricted(join(repo, 'pkg'), /working tree/);
  });

  it('R29 a folder that is not a git repository is not restricted: detection reports not-git-root as before', async () => {
    // tmpdir 之上没有仓库
    const plain = join(base, 'plain');
    mkdirSync(plain);
    const app = { ...hostScopedApp(plain), workspace: { getRoot: async () => plain } } as unknown as CoPluginApp;
    const { guard } = installRepoSafetyGuard(app);
    expect(await guard.check(plain, { fresh: true })).toEqual({ kind: 'trusted' });
    expect(await detectRepo(app)).toMatchObject({ ok: false, reason: 'not-git-root' });
  });

  it('R30 keys evaluated as non-redirecting stay trusted and leak nothing: mailmap.file / diff.orderFile / commit.template pointing at an outside file', async () => {
    const outside = join(secretDir, 'f.txt');
    for (const key of ['mailmap.file', 'diff.orderFile', 'commit.template']) {
      git(repo, 'config', key, outside);
    }
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect(await guard.check(repo, { fresh: true })).toEqual({ kind: 'trusted' });
    expect(await everythingShown(app)).not.toContain(SECRET);
    expect((await stageFile(app, repo, 'f.txt')).ok).toBe(true);
    expect(await gitCommit(app, repo, 'typed message')).toMatchObject({ ok: true });
    expect(await readHeadMessage(app, repo)).toBe('typed message');
    expect(git(repo, 'show', '--stat', 'HEAD')).not.toContain(SECRET);
  });

  it('R30b core.attributesFile naming an outside file: git prints words of that file on stderr ("<word> is not a valid attribute name"), which a failing command would put in a toast; with core.excludesFile it is restricted', async () => {
    const outside = join(secretDir, 'netrc');
    writeFileSync(outside, `machine example.com login me password p@ss/${SECRET}\n`);
    git(repo, 'config', 'core.attributesFile', outside);
    appendFileSync(join(repo, 'f.txt'), 'two\n');

    // 证明泄露:不经守卫,插件自己的 git add 的 stderr 带出外部文件里的词
    const add = await gitExec(realApp(), repo, ['add', '--', 'f.txt']);
    expect(add.stderr).toContain(`p@ss/${SECRET} is not a valid attribute name`);

    git(repo, 'config', '--unset-all', 'core.attributesFile');

    for (const key of ['core.attributesFile', 'core.excludesFile']) {
      git(repo, 'config', key, outside);
      const stderr: string[] = [];
      const app = tamperedApp({ stderr });
      const { guard } = installRepoSafetyGuard(app);
      const verdict = await guard.check(repo, { fresh: true });
      expect(verdict).toMatchObject({ kind: 'restricted', reason: 'unsafe-config', keys: [key.toLowerCase()] });
      expect(verdict.kind === 'restricted' && verdict.message).toContain('point git away from this folder');
      const staged = await stageFile(app, repo, 'f.txt');
      expect(staged.ok).toBe(false);
      expect(`${staged.error}${await everythingShown(app)}${stderr.join('')}`).not.toContain(SECRET);
      git(repo, 'config', '--unset-all', key);
    }
  });

  it('R31 probeRepoSafety reports reason unsafe-layout for a git dir outside the workspace', async () => {
    rmSync(repoGit(), { recursive: true });
    writeFileSync(repoGit(), `gitdir: ${privGit()}\n`);
    expect(await probeRepoSafety(realApp(), repo)).toMatchObject({ kind: 'restricted', reason: 'unsafe-layout' });
  });
});

// ---------------------------------------------------------------------------------------------
// 整分支终审(F1–F6 + 系统枚举)的 real-git 规范。写法同上:每条先证明"去掉对应防护时攻击成立"。

interface Tamper {
  /** 去掉这些 `-c key=value`(按 key 匹配,大小写不敏感)。 */
  readonly dropPins?: readonly string[];
  /** 去掉这些独立参数(如 `--submodule=short`)。 */
  readonly dropArgs?: readonly string[];
  /** 去掉插件 env 里的这些变量。 */
  readonly dropEnv?: readonly string[];
  /** 追加 env(如 GIT_TRACE=1)。 */
  readonly addEnv?: Readonly<Record<string, string>>;
  /** 每次调用的 stderr 收集到这里。 */
  readonly stderr?: string[];
}

// 包一层 app.shell.exec:按需去掉插件加固的某一部分(模拟"未加该防护"),或加 GIT_TRACE 观察子进程。
function tamperedApp(t: Tamper, inner: CoPluginApp = realApp()): CoPluginApp {
  const exec = inner.shell.exec.bind(inner.shell);
  const pins = new Set((t.dropPins ?? []).map((k) => k.toLowerCase()));
  const dropArgs = new Set(t.dropArgs ?? []);
  const strip = (args: readonly string[]) => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      const next = args[i + 1];
      if (a === '-c' && next !== undefined && pins.has(next.slice(0, next.indexOf('=')).toLowerCase())) {
        i++;
        continue;
      }
      if (dropArgs.has(a)) continue;
      out.push(a);
    }
    return out;
  };
  return {
    ...inner,
    shell: {
      exec: async (cmd: string, args: readonly string[], opts: PluginShellExecOptions = {}) => {
        const env = { ...(opts.env ?? {}), ...(t.addEnv ?? {}) };
        for (const k of t.dropEnv ?? []) delete env[k];
        const r = await exec(cmd, cmd === 'git' ? strip(args) : args, { ...opts, env });
        t.stderr?.push(r.stderr);
        return r;
      },
    },
  } as unknown as CoPluginApp;
}

/** GIT_TRACE 输出里 git 起的子进程(`run_command:` 行)。 */
const spawned = (stderr: readonly string[]) =>
  stderr.flatMap((s) => s.split('\n')).filter((l) => l.includes('trace: run_command:'));

describe('nested repositories: no plugin git command may spawn a process inside one (real git)', () => {
  let sub: string;

  // 外层 index 里有 gitlink `sub`(无需 .gitmodules),sub/ 是嵌套仓库:HEAD 与 gitlink 不同、工作树有改动,
  // 其**自己的** config 带 diff.external / textconv / filter / fsmonitor(外层 config 的受限检测看不到)。
  function plantNestedRepo(): void {
    sub = join(repo, 'sub');
    mkdirSync(sub);
    git(sub, 'init', '-q', '-b', 'main');
    writeFileSync(join(sub, 's.txt'), 's\n');
    writeFileSync(join(sub, '.gitattributes'), '* filter=x diff=x\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-qm', 's1');
    git(repo, '-c', 'advice.addEmbeddedRepo=false', 'add', 'sub');
    git(repo, 'commit', '-qm', 'gitlink');
    appendFileSync(join(sub, 's.txt'), 's2\n');
    git(sub, 'commit', '-qam', 's2');
    appendFileSync(join(sub, 's.txt'), 's3\n');
    git(sub, 'config', 'diff.external', marker('sub-ext'));
    git(sub, 'config', 'diff.x.textconv', marker('sub-textconv'));
    git(sub, 'config', 'diff.x.command', marker('sub-diffcmd'));
    git(sub, 'config', 'filter.x.clean', marker('sub-clean'));
    git(sub, 'config', 'filter.x.smudge', marker('sub-smudge'));
    git(sub, 'config', 'core.fsmonitor', marker('sub-fsmonitor'));
    plantHooks(join(sub, '.git', 'hooks'));
    clearMarks();
  }

  const SUB_CHANGE = { path: 'sub', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' } as const;

  it('R32 outer diff.submodule=diff + nested repo with diff.external: without the pin/flag, auto-selecting ` M sub` executes the nested config; hardened → nothing runs and the gitlink change is still shown', async () => {
    plantNestedRepo();
    git(repo, 'config', 'diff.submodule', 'diff');

    // 证明 fixture:去掉 -c diff.submodule=short 与 --submodule=short,其它加固(--no-ext-diff 等)原样保留
    const bare = tamperedApp({ dropPins: ['diff.submodule'], dropArgs: ['--submodule=short'] });
    const listed = await scanStatus(bare, repo);
    expect(listed.map((c) => `${c.statusX}${c.statusY} ${c.path}`)).toEqual([' M sub']);
    await fetchDiff(bare, repo, listed[0]!);
    expect(marks().some((m) => m.startsWith('sub-'))).toBe(true);
    clearMarks();

    // 两道防线各自单独也够(命令行 -c 盖过仓库 config;--submodule=short 盖过两者)
    for (const t of [{ dropPins: ['diff.submodule'] }, { dropArgs: ['--submodule=short'] }, {}] as Tamper[]) {
      const app = tamperedApp(t);
      const changes = await scanStatus(app, repo);
      expect(changes.map((c) => c.path)).toEqual(['sub']);
      for (const mode of ['changed', 'staged'] as const) {
        const d = await fetchDiff(app, repo, changes[0]!, mode);
        expect(d.ok).toBe(true);
        if (mode === 'changed') expect(d.ok && d.unifiedDiff).toMatch(/^\+Subproject commit [0-9a-f]{40}$/m);
      }
      await gitExec(app, repo, ['log', '-1', '-p']);
      await gitExec(app, repo, ['show', 'HEAD']);
      expect(marks()).toEqual([]);
    }

    // 配置层(双保险):外层 diff.submodule=diff 本身即受限
    const guarded = realApp();
    const { guard } = installRepoSafetyGuard(guarded);
    expect(await guard.check(repo, { fresh: true })).toMatchObject({ kind: 'restricted', keys: ['diff.submodule'] });
  });

  it('R33 GIT_TRACE: every git command the plugin runs spawns no child process at all in a repo with a hostile nested repository (status / diff / stage / unstage / discard / commit / amend)', async () => {
    plantNestedRepo();
    // 让 git 更想进子仓库的外层设置(均不在受限键里,靠命令行中和)
    git(repo, 'config', 'status.submoduleSummary', 'true');
    git(repo, 'config', 'diff.ignoreSubmodules', 'none');
    git(repo, 'config', 'submodule.sub.ignore', 'none');
    git(repo, 'config', 'submodule.sub.url', join(base, 'nowhere'));
    writeFileSync(join(repo, '.gitmodules'), `[submodule "sub"]\n\tpath = sub\n\turl = ${join(base, 'nowhere')}\n\tignore = none\n`);
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');

    const driveAll = async (app: CoPluginApp) => {
      const changes = await scanStatus(app, repo);
      await readStatusHash(app, repo);
      for (const c of changes) await fetchDiff(app, repo, c);
      await readHeadMessage(app, repo);
      await hasHeadCommit(app, repo);
      await detectRepoHooks(app, repo);
      await gitExec(app, repo, ['rev-parse', '--show-prefix']);
      expect((await stageFile(app, repo, 'sub')).ok).toBe(true);
      await fetchDiff(app, repo, { ...SUB_CHANGE, statusX: 'M', statusY: ' ' }, 'staged');
      _resetRestoreCache();
      expect((await unstageFile(app, repo, 'sub')).ok).toBe(true);
      expect((await gitExec(app, repo, ['add', '--', 'sub'])).exitCode).toBe(0);
      expect((await gitExec(app, repo, ['restore', '--staged', '--', 'sub'])).exitCode).toBe(0);
      expect((await gitExec(app, repo, ['reset', 'HEAD', '--', 'sub'])).exitCode).toBe(0);
      // 子模块条目的文件级 Discard 被如实拒绝(R74);checkout 本身照样验证不起子进程
      expect(await discardFile(app, repo, 'sub')).toEqual({ ok: false, error: SUBMODULE_DISCARD_ERROR });
      expect((await gitExec(app, repo, ['checkout', '--', 'sub'])).exitCode).toBe(0);
      expect((await stageFile(app, repo, 'sub')).ok).toBe(true);
      expect(await gitCommit(app, repo, 'bump sub')).toMatchObject({ ok: true });
      appendFileSync(join(repo, 'f.txt'), 'two\n');
      expect((await stageFile(app, repo, 'f.txt')).ok).toBe(true);
      expect(await gitCommit(app, repo, 'amended', { amend: true })).toMatchObject({ ok: true });
      await gitExec(app, repo, ['status']);
      await gitExec(app, repo, ['log', '-1', '-p']);
    };

    const stderr: string[] = [];
    await driveAll(tamperedApp({ addEnv: { GIT_TRACE: '1' }, stderr }));
    expect(stderr.join('').includes('trace: built-in: git status')).toBe(true); // trace 确实开着
    expect(spawned(stderr)).toEqual([]);
    expect(marks()).toEqual([]);

    // 证明 fixture:去掉子模块相关加固后,同一组操作会在 sub/ 里起 git(`run_command: cd sub; ...`;其 config 被执行见 R34)
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    const bareErr: string[] = [];
    await driveAll(
      tamperedApp({
        addEnv: { GIT_TRACE: '1' },
        stderr: bareErr,
        dropPins: ['status.submoduleSummary', 'maintenance.auto', 'gc.auto'],
        dropArgs: ['--ignore-submodules=dirty'],
      }),
    );
    const children = spawned(bareErr);
    expect(children.some((l) => /run_command: cd sub;.* git status --porcelain=2/.test(l))).toBe(true);
    expect(children.some((l) => l.includes('git submodule summary'))).toBe(true);
    expect(children.some((l) => l.includes('git maintenance run --auto'))).toBe(true);
  });

  it('R34 -c diff.ignoreSubmodules=dirty would not be enough: submodule.<name>.ignore=none outranks it, the command-line flag does not', async () => {
    plantNestedRepo();
    git(repo, 'config', 'submodule.sub.ignore', 'none');
    git(repo, 'config', 'submodule.sub.url', join(base, 'nowhere'));
    writeFileSync(join(repo, '.gitmodules'), `[submodule "sub"]\n\tpath = sub\n\turl = ${join(base, 'nowhere')}\n`);
    dirty(sub, 's.txt');

    // 子仓库里的 `git status` 一定会跑它的 core.fsmonitor;clean filter 是否触发取决于时间戳(racy),不作断言
    git(repo, '--no-optional-locks', '-c', 'diff.ignoreSubmodules=dirty', 'status', '--porcelain');
    expect(marks()).toContain('sub-fsmonitor');
    clearMarks();

    await scanStatus(realApp(), repo);
    expect(marks()).toEqual([]);
  });
});

describe('commit never reaches the network unless the user confirmed running repository hooks (real git)', () => {
  // partial clone 配置 + HEAD 里 f.txt 的 blob 缺失 + 已暂存的修改:commit 结束时打印变更摘要要读旧 blob,
  // 触发惰性拉取 → 传输层执行仓库 config 指定的程序。无 hooks,所以提交前不会弹确认。
  // 暂存 f.txt 的又一处修改,并删掉它在 HEAD 里的 blob(= 该对象"尚未从 promisor 远端取回")
  function stageWithMissingOldBlob(): void {
    const blob = git(repo, 'rev-parse', 'HEAD:f.txt').trim();
    appendFileSync(join(repo, 'f.txt'), 'more\n');
    git(repo, 'add', 'f.txt');
    rmSync(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  }
  function plantLazyFetchRepo(url: string): void {
    stageWithMissingOldBlob();
    git(repo, 'config', 'extensions.partialClone', 'origin');
    git(repo, 'config', 'remote.origin.promisor', 'true');
    git(repo, 'config', 'remote.origin.url', url);
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
    clearMarks();
  }
  // 两道防线:--quiet(不读旧 blob,根本不触发拉取)与断网(触发了也出不去)。证明 fixture 时两道都去掉。
  const NETWORK_BLOCK: Tamper = { dropPins: ['protocol.allow'], dropEnv: ['GIT_NO_LAZY_FETCH', 'GIT_ALLOW_PROTOCOL'] };
  const UNPROTECTED: Tamper = { ...NETWORK_BLOCK, dropArgs: ['--quiet'] };
  const head = () => git(repo, 'rev-parse', 'HEAD').trim();
  const touch = (name: string) => `sh -c 'touch "${join(markDir, name)}"; exit 1' x`;

  it('R35 ssh promisor remote + core.sshCommand: without the network block a hook-less Commit executes it; the plugin commit / amend runs nothing, still succeeds, and the repo stays trusted', async () => {
    plantLazyFetchRepo('ssh://host.invalid/y');
    git(repo, 'config', 'core.sshCommand', touch('ssh'));

    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect((await guard.check(repo, { fresh: true })).kind).toBe('trusted'); // blobless clone 不受限
    expect(await detectRepoHooks(app, repo)).toEqual({ kind: 'none' }); // 不会弹确认

    const before = head();
    expect(await gitCommit(app, repo, 'second')).toMatchObject({ ok: true });
    expect(head()).not.toBe(before);
    expect(marks()).toEqual([]);

    appendFileSync(join(repo, 'g.txt'), 'more\n');
    expect((await stageFile(app, repo, 'g.txt')).ok).toBe(true);
    const beforeAmend = head();
    expect(await gitCommit(app, repo, 'amended', { amend: true })).toMatchObject({ ok: true });
    expect(head()).not.toBe(beforeAmend);
    expect(marks()).toEqual([]);

    // 证明 fixture:去掉断网参数 / 环境变量后,同样的提交执行了仓库的 core.sshCommand
    stageWithMissingOldBlob();
    await gitCommit(tamperedApp(UNPROTECTED), repo, 'third');
    expect(marks()).toEqual(['ssh']);
    clearMarks();

    // 各自单独也够:只留断网(去掉 --quiet)→ 不执行,但 git 以"读不到旧 blob"失败(提交其实已创建);
    // 只留 --quiet(去掉断网)→ 不执行且成功。两者并用 = 上面的插件原样行为。
    for (const [t, ok] of [[{ dropArgs: ['--quiet'] }, false], [NETWORK_BLOCK, true]] as Array<[Tamper, boolean]>) {
      stageWithMissingOldBlob();
      const at = head();
      expect((await gitCommit(tamperedApp(t), repo, 'again')).ok).toBe(ok);
      expect(head()).not.toBe(at);
      expect(marks()).toEqual([]);
    }
  });

  it('R36 http promisor remote + local credential.helper=!cmd: same path; the plugin commit never contacts the server nor runs the helper', async () => {
    let requests = 0;
    const server: Server = createServer((_req, res) => {
      requests++;
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      plantLazyFetchRepo(`http://127.0.0.1:${port}/y`);
      git(repo, 'config', 'credential.helper', `!touch "${join(markDir, 'cred')}"; :`);

      const before = head();
      expect(await gitCommit(realApp(), repo, 'second')).toMatchObject({ ok: true });
      expect(head()).not.toBe(before);
      expect({ requests, marks: marks() }).toEqual({ requests: 0, marks: [] });

      stageWithMissingOldBlob();
      await gitCommit(tamperedApp(UNPROTECTED), repo, 'third');
      expect(requests).toBeGreaterThan(0);
      expect(marks()).toEqual(['cred']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('R37 hooks see the block only when the user was not asked: an unconfirmed commit hands hooks GIT_ALLOW_PROTOCOL="" / GIT_NO_LAZY_FETCH=1, a confirmed one hands them neither (their own fetches keep working)', async () => {
    const envFile = join(markDir, 'hook-env');
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(
      hook,
      `#!/bin/sh\nprintf 'allow=[%s] lazy=[%s] params=[%s]\\n' "\${GIT_ALLOW_PROTOCOL-unset}" "\${GIT_NO_LAZY_FETCH-unset}" "$GIT_CONFIG_PARAMETERS" > "${envFile}"\n`,
    );
    chmodSync(hook, 0o755);
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
    const app = realApp();

    appendFileSync(join(repo, 'f.txt'), 'two\n');
    git(repo, 'add', 'f.txt');
    expect(await gitCommit(app, repo, 'confirmed', { hooksConfirmed: true })).toMatchObject({ ok: true });
    const confirmed = readFileSync(envFile, 'utf8');
    expect(confirmed).toContain('allow=[unset] lazy=[unset]');
    expect(confirmed).not.toContain('protocol.allow');

    appendFileSync(join(repo, 'f.txt'), 'three\n');
    git(repo, 'add', 'f.txt');
    expect(await gitCommit(app, repo, 'unconfirmed')).toMatchObject({ ok: true });
    const unconfirmed = readFileSync(envFile, 'utf8');
    expect(unconfirmed).toContain('allow=[] lazy=[1]');
    expect(unconfirmed).toContain('protocol.allow');
  });

  it('R38 a confirmed commit in the same lazy-fetch repository does reach the transport (documented: the user agreed to run repository code)', async () => {
    plantLazyFetchRepo('ssh://host.invalid/y');
    git(repo, 'config', 'core.sshCommand', touch('ssh'));
    plantHooks();
    expect((await detectRepoHooks(realApp(), repo)).kind).toBe('present');
    // 确认后只是不再断网;--quiet 仍在,插件自己的提交不触发拉取。这里用去掉 --quiet 来代表
    // "hooks 里的 git 命令读到缺失对象"——那时传输层会被执行,属于用户已同意的仓库代码范围。
    await gitCommit(tamperedApp({ dropArgs: ['--quiet'] }), repo, 'second', { hooksConfirmed: true });
    expect(marks()).toContain('ssh');
    clearMarks();
    stageWithMissingOldBlob();
    await gitCommit(tamperedApp({ dropArgs: ['--quiet'] }), repo, 'third');
    expect(marks()).not.toContain('ssh');
  });
});

describe('paths are passed to git literally, never as pathspec patterns (real git)', () => {
  const LITERAL: Tamper = { dropEnv: ['GIT_LITERAL_PATHSPECS'] };
  const porcelain = () => git(repo, 'status', '--porcelain').split('\n').filter(Boolean).sort();

  // 被跟踪的文件名本身就是 pattern:`*`、`:(glob)**`、`[id].tsx`(后者是 Next.js 等的常见路由文件名,还会匹配 `i.tsx`)
  beforeEach(() => {
    for (const name of ['*', ':(glob)**', '[id].tsx', 'i.tsx']) writeFileSync(join(repo, name), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'pattern-named files');
    editAll();
  });
  const editAll = () => {
    for (const name of ['*', ':(glob)**', '[id].tsx', 'i.tsx', 'f.txt', 'g.txt']) appendFileSync(join(repo, name), 'edit\n');
  };

  it.each(['*', ':(glob)**'])('R39 stage / unstage / discard of a file named %s touches only that file (without the env it hits every changed file)', async (name) => {
    const others = [' M *', ' M :(glob)**', ' M [id].tsx', ' M f.txt', ' M g.txt', ' M i.tsx'].filter((l) => l !== ` M ${name}`);

    // 证明 fixture:不按字面处理时,"暂存这一个文件"暂存了全部,"丢弃这一个文件"丢掉了全部改动
    expect((await stageFile(tamperedApp(LITERAL), repo, name)).ok).toBe(true);
    expect(porcelain().every((l) => l.startsWith('M  '))).toBe(true);
    git(repo, 'reset', '-q');
    expect((await discardFile(tamperedApp(LITERAL), repo, name)).ok).toBe(true);
    expect(porcelain()).toEqual([]);
    editAll();

    const app = realApp();
    expect((await stageFile(app, repo, name)).ok).toBe(true);
    expect(porcelain()).toEqual([`M  ${name}`, ...others].sort());

    // 把其余文件也暂存,再只取消暂存这一个(restore 与 reset 两条路径)
    git(repo, 'add', '.');
    _resetRestoreCache();
    expect((await unstageFile(app, repo, name)).ok).toBe(true);
    expect(porcelain()).toEqual([` M ${name}`, ...others.map((l) => l.replace(' M ', 'M  '))].sort());
    git(repo, 'add', '.');
    expect((await gitExec(app, repo, ['restore', '--staged', '--', name])).exitCode).toBe(0);
    expect(porcelain()).toEqual([` M ${name}`, ...others.map((l) => l.replace(' M ', 'M  '))].sort());
    git(repo, 'reset', '-q');

    expect((await discardFile(app, repo, name)).ok).toBe(true);
    expect(porcelain()).toEqual(others.sort());
    expect(readFileSync(join(repo, name), 'utf8')).toBe('base\n');
  });

  it('R40 an ordinary repository: `[id].tsx` no longer drags `i.tsx` along, and its diff shows that file only', async () => {
    expect((await stageFile(tamperedApp(LITERAL), repo, '[id].tsx')).ok).toBe(true);
    expect(porcelain()).toContain('M  i.tsx'); // 证明 fixture
    git(repo, 'reset', '-q');

    const app = realApp();
    const change = (await scanStatus(app, repo)).find((c) => c.path === '[id].tsx')!;
    const loose = await fetchDiff(tamperedApp(LITERAL), repo, change);
    expect(loose.ok && loose.unifiedDiff).toContain('diff --git a/i.tsx b/i.tsx');
    const diff = await fetchDiff(app, repo, change);
    expect(diff.ok && diff.unifiedDiff).toContain('diff --git a/[id].tsx b/[id].tsx');
    expect(diff.ok && diff.unifiedDiff).not.toContain('i.tsx b/i.tsx');

    expect((await stageFile(app, repo, '[id].tsx')).ok).toBe(true);
    expect(porcelain()).toContain(' M i.tsx');
    expect(porcelain()).toContain('M  [id].tsx');
    const staged = await fetchDiff(app, repo, change, 'staged');
    expect(staged.ok && staged.unifiedDiff).toContain('diff --git a/[id].tsx b/[id].tsx');
    expect((await discardFile(app, repo, 'i.tsx')).ok).toBe(true);
    expect(readFileSync(join(repo, '[id].tsx'), 'utf8')).toBe('base\nedit\n');
  });

  it('R41 literal mode has no side effects on the other subcommands: untracked directory staging, hunk apply, status, head meta, config / layout probes, commit (whose hooks keep glob pathspecs)', async () => {
    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect((await guard.check(repo, { fresh: true })).kind).toBe('trusted');
    mkdirSync(join(repo, 'dir'));
    writeFileSync(join(repo, 'dir', 'u.txt'), 'u\n');
    expect((await scanStatus(app, repo)).map((c) => c.path)).toContain('dir/');
    // 未跟踪行:面板传 untracked(runFileAction),与这里相同
    expect((await stageFile(app, repo, 'dir/', { untracked: true })).ok).toBe(true);
    expect(porcelain()).toContain('A  dir/u.txt');
    expect((await stageHunk(app, repo, git(repo, 'diff', '--', 'f.txt'))).ok).toBe(true);
    expect(await readHeadMessage(app, repo)).toBe('pattern-named files');
    expect(await hasHeadCommit(app, repo)).toBe(true);

    // commit:hooks 里的 glob pathspec 照常可用(环境变量没有传给 hooks)
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\ngit diff --cached --name-only -- '*.txt' > "${join(markDir, 'globbed')}" || exit 1\n`);
    chmodSync(hook, 0o755);
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
    expect(await gitCommit(app, repo, 'literal', { hooksConfirmed: true })).toMatchObject({ ok: true });
    expect(readFileSync(join(markDir, 'globbed'), 'utf8').split('\n').filter(Boolean).sort()).toEqual(['dir/u.txt', 'f.txt']);
  });
});

describe('paths reported by git are not trusted: forged index entries and copy records (real git)', () => {
  // 手写一个 v2 index(`git update-index` 会拒绝这些路径,但读 index 时 git 不校验):每个条目都指向 f.txt 的 blob。
  function forgeIndex(paths: readonly string[]): void {
    const sha = Buffer.from(git(repo, 'rev-parse', 'HEAD:f.txt').trim(), 'hex');
    const entries = [...paths].sort().map((p) => {
      const name = Buffer.from(p);
      const head = Buffer.alloc(62);
      head.writeUInt32BE(0o100644, 24);
      sha.copy(head, 40);
      head.writeUInt16BE(name.length, 60);
      const len = 62 + name.length;
      return Buffer.concat([head, name, Buffer.alloc(8 - (len % 8))]);
    });
    const header = Buffer.alloc(12);
    header.write('DIRC');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(entries.length, 8);
    const body = Buffer.concat([header, ...entries]);
    writeFileSync(join(repo, '.git', 'index'), Buffer.concat([body, createHash('sha1').update(body).digest()]));
  }

  it('R42 forged index listing ../outside, an absolute path and .git/hooks/x: git reports them and `checkout --` writes into the git directory; the plugin drops the entries and refuses to act on such paths', async () => {
    const outside = join(realpathSync(base), 'outside.txt');
    writeFileSync(outside, 'OUTSIDE-SECRET\n');
    forgeIndex(['f.txt', 'g.txt', '../outside.txt', outside, '.git/hooks/planted', '.GIT/hooks/planted2']);

    // 证明 fixture:git 自己把这些条目当成正常变更列出;discard(checkout --)把 blob 写进 .git/hooks
    const raw = git(repo, 'status', '--porcelain=v1', '-z').split('\0').filter(Boolean);
    expect(raw).toEqual(expect.arrayContaining(['AM ../outside.txt', `AM ${outside}`, 'AD .git/hooks/planted']));
    const loose = await gitExec(realApp(), repo, ['checkout', '--', '.git/hooks/planted']);
    expect(loose.exitCode).toBe(0);
    expect(existsSync(join(repo, '.git', 'hooks', 'planted'))).toBe(true);
    rmSync(join(repo, '.git', 'hooks', 'planted'));

    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect((await guard.check(repo, { fresh: true })).kind).toBe('trusted');
    const spawnedCommands: string[] = [];
    const spy = {
      ...app,
      shell: {
        exec: (cmd: string, args: readonly string[], opts?: PluginShellExecOptions) => {
          spawnedCommands.push([cmd, ...args].join(' '));
          return app.shell.exec(cmd, args, opts);
        },
      },
    } as unknown as CoPluginApp;

    // 解析器丢弃这些条目(g.txt 的条目指向 f.txt 的 blob,是唯一合法的变更);扫描整体以 UnsafeIndexError 拒绝
    const porcelain = (await gitExec(spy, repo, ['status', '--porcelain=v1', '-z'])).stdout;
    expect(parsePorcelainStatus(porcelain).map((c) => c.path)).toEqual(['g.txt']);
    const scan = await scanStatus(spy, repo).then(() => null, (e: unknown) => e);
    expect(scan).toBeInstanceOf(UnsafeIndexError);
    expect([...(scan as UnsafeIndexError).paths].sort()).toEqual(['../outside.txt', '.GIT/hooks/planted2', '.git/hooks/planted', outside].sort());
    spawnedCommands.length = 0;

    for (const path of ['../outside.txt', outside, '.git/hooks/planted', '.GIT/hooks/planted2']) {
      expect((await discardFile(spy, repo, path)).ok).toBe(false);
      expect((await stageFile(spy, repo, path)).ok).toBe(false);
      expect((await unstageFile(spy, repo, path)).ok).toBe(false);
      const change = { path, status: 'A', statusX: 'A', statusY: 'M', kind: 'text' } as const;
      for (const mode of ['changed', 'staged'] as const) {
        const d = await fetchDiff(spy, repo, change, mode);
        expect(d.ok).toBe(false);
        expect(JSON.stringify(d)).not.toContain('OUTSIDE-SECRET');
      }
    }
    expect(spawnedCommands).toEqual([]);
    expect(readdirSync(join(repo, '.git', 'hooks')).filter((n) => n.startsWith('planted'))).toEqual([]);
    expect(readFileSync(outside, 'utf8')).toBe('OUTSIDE-SECRET\n');
  });

  it('R42b the forged entries are staged: a plain commit writes them into the tree although the file list never showed them; once the scan has flagged the index the guard refuses the commit', async () => {
    forgeIndex(['f.txt', 'g.txt', '../outside.txt', '.git/hooks/planted']);
    const tree = () => git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean);

    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect((await guard.check(repo, { fresh: true })).kind).toBe('trusted');
    const head = git(repo, 'rev-parse', 'HEAD');

    // 插件的流程:refresh 扫描 status → UnsafeIndexError → guard.restrict(main.ts 的 load 就是这么做的)
    const scan = await scanStatus(app, repo).then(() => null, (e: unknown) => e);
    expect(scan).toBeInstanceOf(UnsafeIndexError);
    guard.restrict(repo, { kind: 'restricted', reason: 'unsafe-index', keys: [], message: (scan as Error).message });
    const refused = await gitCommit(app, repo, 'looks harmless');
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain('its index lists paths that are outside this folder or inside the git directory');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);

    // 证明缺口:没有这一步时,同一个提交把面板没显示的条目写进了 tree
    expect(await gitCommit(realApp(), repo, 'looks harmless')).toMatchObject({ ok: true });
    expect(tree()).toEqual(expect.arrayContaining(['../outside.txt', '.git/hooks/planted']));
  });

  it('R60 names git records normally but the plugin will not hand to git (`c:notes.txt`, `..\\x`, `a:b`): they are listed as inoperable rows instead of vanishing, every operation on them is refused without starting a process, and what the Staged section shows is exactly what the commit contains', async () => {
    const ODD = ['..\\x', 'a:b', 'c:notes.txt'];
    for (const name of ODD) writeFileSync(join(repo, name), 'odd\n');
    git(repo, 'add', '--', ...ODD);
    appendFileSync(join(repo, 'a:b'), 'edited after staging\n');
    writeFileSync(join(repo, 'd:untracked'), 'u\n');
    appendFileSync(join(repo, 'f.txt'), 'two\n');

    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect(await guard.check(repo, { fresh: true })).toEqual({ kind: 'trusted' });
    const spawned: string[][] = [];
    const spy = {
      ...app,
      shell: { exec: (cmd: string, args: readonly string[], opts?: PluginShellExecOptions) => (spawned.push([cmd, ...args]), app.shell.exec(cmd, args, opts)) },
    } as unknown as CoPluginApp;

    const changes = await scanStatus(spy, repo);
    expect(changes.map((c) => [c.statusX + c.statusY, c.path, c.inoperable === true])).toEqual([
      ['A ', '..\\x', true], ['AM', 'a:b', true], ['A ', 'c:notes.txt', true], [' M', 'f.txt', false], ['??', 'd:untracked', true],
    ]);
    // 扫描本身只跑了 status 与 numstat,参数里没有这些名字
    expect(spawned.flat().filter((a) => [...ODD, 'd:untracked'].includes(a))).toEqual([]);
    spawned.length = 0;

    for (const path of [...ODD, 'd:untracked']) {
      expect((await stageFile(spy, repo, path)).ok).toBe(false);
      expect((await unstageFile(spy, repo, path)).ok).toBe(false);
      expect((await discardFile(spy, repo, path)).ok).toBe(false);
      for (const mode of ['changed', 'staged'] as const) {
        expect((await fetchDiff(spy, repo, changes.find((c) => c.path === path)!, mode)).ok).toBe(false);
      }
    }
    expect(spawned).toEqual([]);
    expect(readFileSync(join(repo, 'a:b'), 'utf8')).toBe('odd\nedited after staging\n');

    // 提交:Staged 段显示的条目 = 这次提交实际包含的路径(修复前这三行不显示,提交照样包含它们)
    const stagedShown = changes.filter((c) => c.statusX !== ' ' && c.statusX !== '?').map((c) => c.path);
    expect(stagedShown).toEqual(ODD);
    expect(await gitCommit(spy, repo, 'odd names')).toEqual({ ok: true });
    const committed = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'], { cwd: repo, env: ENV, encoding: 'utf8' }).split('\0').filter(Boolean);
    expect(committed).toEqual(stagedShown);
  });

  it('R43 status.renames=copies: git emits copy records (`C  new\\0orig\\0`); the plugin pins rename detection so the list does not depend on repository config, and still parses copies correctly if they appear', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-qm', 'a');
    writeFileSync(join(repo, 'copy.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    appendFileSync(join(repo, 'a.txt'), 'six\n');
    git(repo, 'add', '.');
    git(repo, 'mv', 'g.txt', 'g2.txt');
    git(repo, 'config', 'status.renames', 'copies');
    git(repo, 'config', 'diff.renames', 'copies');

    // 证明 fixture
    expect(git(repo, 'status', '--porcelain=v1', '-z').split('\0')).toEqual(expect.arrayContaining(['C  copy.txt', 'a.txt']));

    const summary = (cs: Awaited<ReturnType<typeof scanStatus>>) => cs.map((c) => `${c.statusX}${c.statusY} ${c.status} ${c.path}${c.oldPath ? ` <- ${c.oldPath}` : ''}`);
    const expected = ['M  M a.txt', 'A  A copy.txt', 'R  R g2.txt <- g.txt'];
    expect(summary(await scanStatus(realApp(), repo))).toEqual(expected);
    // 去掉固定参数(= 仓库 config 生效,git 输出 C 记录):解析仍不产生伪条目
    const unpinned = summary(await scanStatus(tamperedApp({ dropPins: ['status.renames', 'diff.renames'] }), repo));
    expect(unpinned).toEqual(['M  M a.txt', 'C  A copy.txt', 'R  R g2.txt <- g.txt']);

    // 仓库把重命名检测关掉也不影响列表
    git(repo, 'config', 'status.renames', 'false');
    git(repo, 'config', 'diff.renames', 'false');
    expect(summary(await scanStatus(realApp(), repo))).toEqual(expected);
  });
});

describe('config enumeration: keys neutralized by fixed arguments / environment, one real-git assertion each', () => {
  const setAll = (pairs: Record<string, string>) => {
    for (const [k, v] of Object.entries(pairs)) git(repo, 'config', k, v);
  };

  it('R44 output-shaping keys (colour, diff prefixes, context, encodings, status / log presentation): parsed output is identical to a default repository; with the pins stripped it is not', async () => {
    writeFileSync(join(repo, 'f.txt'), Array.from({ length: 9 }, (_, i) => `line ${i + 1}\n`).join(''));
    git(repo, 'add', 'f.txt');
    git(repo, 'commit', '-qm', 'héllo wörld');
    git(repo, 'notes', 'add', '-m', 'NOTE-TEXT');
    writeFileSync(join(repo, 'f.txt'), readFileSync(join(repo, 'f.txt'), 'utf8').replace('line 5', 'line five'));
    writeFileSync(join(repo, 'new.txt'), 'n\n');

    const read = async (app: CoPluginApp) => {
      const changes = await scanStatus(app, repo);
      const diff = await fetchDiff(app, repo, changes.find((c) => c.path === 'f.txt')!);
      return {
        changes: changes.map((c) => `${c.statusX}${c.statusY} ${c.path}`),
        diff: diff.ok ? diff.unifiedDiff.replace(/^index .*$/m, 'index') : diff,
        head: await readHeadMessage(app, repo),
      };
    };
    const baseline = await read(realApp());
    expect(baseline.changes).toEqual([' M f.txt', '?? new.txt']);
    expect(baseline.diff).toBe(
      'diff --git a/f.txt b/f.txt\nindex\n--- a/f.txt\n+++ b/f.txt\n@@ -2,7 +2,7 @@ line 1\n line 2\n line 3\n line 4\n-line 5\n+line five\n line 6\n line 7\n line 8\n',
    );
    expect(baseline.head).toBe('héllo wörld');

    setAll({
      'color.ui': 'always', 'color.diff': 'always', 'color.status': 'always',
      'diff.noprefix': 'true', 'diff.mnemonicPrefix': 'true', 'diff.srcPrefix': 'x/', 'diff.dstPrefix': 'y/',
      'diff.context': '0', 'diff.interHunkContext': '9', 'diff.suppressBlankEmpty': 'true', 'diff.relative': 'true',
      'diff.algorithm': 'patience', 'diff.wsErrorHighlight': 'all', 'diff.colorMoved': 'zebra',
      'i18n.logOutputEncoding': 'UTF-16', 'i18n.commitEncoding': 'ISO-8859-1',
      'status.branch': 'true', 'status.short': 'true', 'status.showStash': 'true', 'status.aheadBehind': 'true',
      'status.relativePaths': 'false', 'column.ui': 'always', 'column.status': 'always',
      'format.pretty': 'fuller', 'log.decorate': 'full', 'log.showRoot': 'true', 'log.date': 'relative',
      'notes.displayRef': 'refs/notes/*', 'core.quotePath': 'true', 'core.abbrev': '40',
      'apply.ignoreWhitespace': 'change', 'apply.whitespace': 'error',
    });

    // 这些键只改呈现,不执行、不越界:仓库不受限,靠固定参数中和
    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect((await guard.check(repo, { fresh: true })).kind).toBe('trusted');
    expect(await read(app)).toEqual(baseline);

    // 证明 fixture:去掉输出类固定参数后,同一仓库的 diff 带 ANSI 转义、没有 a/ b/ 前缀、零上下文,提交信息变成 UTF-16
    const loose = await read(tamperedApp({ dropPins: PINNED_OUTPUT_CONFIG.map(([k]) => k), dropArgs: ['--no-color'] }));
    expect(loose.diff).toContain('\u001b[');
    expect(loose.diff).not.toContain('--- a/f.txt');
    expect(loose.diff).toContain('@@ -5 +5 @@');
    expect(loose.head).not.toBe('héllo wörld');
    // --no-color 单独也挡得住颜色(color.diff 比 color.ui 具体,仅 -c color.ui=false 不够)
    const flagOnly = await read(tamperedApp({ dropPins: ['color.ui', 'color.diff'] }));
    expect(flagOnly).toEqual(baseline);

    // hunk 级暂存用的是这份 diff:补丁能应用,暂存内容正确
    const diff = await fetchDiff(app, repo, { path: 'f.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' });
    const lines = diff.ok ? diff.unifiedDiff.split('\n') : [];
    const patch = extractHunkPatchFromUnifiedDiff('f.txt', lines.join('\n'), lines.findIndex((l) => l.startsWith('@@')));
    expect((await stageHunk(app, repo, patch!)).ok).toBe(true);
    expect(git(repo, 'show', ':f.txt')).toContain('line five');

    // 提交信息按 UTF-8 记录(不带错误的 encoding 头),读回一致
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
    expect(await gitCommit(app, repo, 'ünïcödé subject')).toMatchObject({ ok: true });
    expect(git(repo, 'cat-file', 'commit', 'HEAD')).not.toMatch(/^encoding /m);
    expect(await readHeadMessage(app, repo)).toBe('ünïcödé subject');
  });

  it('R45 program-valued keys that are not in the restricted list (pager, editor, alias, trace2 targets, ssh / credential / proxy without a fetch): the repository stays trusted and nothing they name is ever started', async () => {
    const trace = (n: string) => join(markDir, `trace2-${n}`);
    setAll({
      'core.pager': marker('pager'), 'pager.status': marker('pager-status'), 'pager.diff': marker('pager-diff'),
      'pager.log': marker('pager-log'), 'pager.show': marker('pager-show'), 'pager.commit': marker('pager-commit'),
      'core.editor': marker('editor'), 'sequence.editor': marker('seq-editor'),
      'alias.status': `!${marker('alias-status')}`, 'alias.diff': `!${marker('alias-diff')}`, 'alias.commit': `!${marker('alias-commit')}`,
      'core.sshCommand': marker('ssh'), 'credential.helper': `!${marker('cred')}`,
      'http.proxy': 'http://127.0.0.1:1', 'url.ext::sh.insteadOf': 'https://', 'remote.origin.url': 'https://host.invalid/x',
      'remote.origin.vcs': 'ext', 'help.autoCorrect': 'immediate', 'help.format': 'web', 'web.browser': marker('browser'),
      'man.viewer': 'x', 'man.x.cmd': marker('man'), 'browser.x.cmd': marker('browser-cmd'),
      'interactive.diffFilter': marker('diff-filter'), 'difftool.x.cmd': marker('difftool'), 'diff.tool': 'x',
      'mergetool.x.cmd': marker('mergetool'), 'merge.tool': 'x',
      'trace2.normalTarget': trace('normal'), 'trace2.eventTarget': trace('event'), 'trace2.perfTarget': trace('perf'),
      'commit.cleanup': 'strip', 'commit.status': 'true', 'commit.verbose': 'true',
      'user.name': 't', 'user.email': 't@t',
    });
    clearMarks();

    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect((await guard.check(repo, { fresh: true })).kind).toBe('trusted');

    await runEverything(app);
    for (const [, op] of WRITE_OPS) {
      git(repo, 'reset', '-q', '--hard');
      expect((await op(app)).ok).toBe(true);
    }
    appendFileSync(join(repo, 'f.txt'), 'again\n');
    expect((await stageFile(app, repo, 'f.txt')).ok).toBe(true);
    expect(await gitCommit(app, repo, 'subject')).toMatchObject({ ok: true });
    expect(await gitCommit(app, repo, 'amended', { amend: true })).toMatchObject({ ok: true });
    await gitExec(app, repo, ['restore', '-h']);
    expect(marks()).toEqual([]);

    // 证明 fixture(trace2):同样的键放在 global 作用域时 git 确实会写文件——local 作用域被 git 忽略
    const globalCfg = join(base, 'global.cfg');
    writeFileSync(globalCfg, `[trace2]\n\tnormalTarget = ${trace('global')}\n`);
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    await scanStatus(app, repo);
    expect(marks()).toEqual(['trace2-global']);
  });
});

// 配置式 hooks 是 git 2.54 的新功能(事件级开关 hook.<event>.enabled 是 2.55)。受限判定对任何 git 版本都断言;
// "不加防护确实会执行"与"事件开关确实关得掉"只有运行测试的 git 支持时才可能断言——能力以 git 自己的
// `git help --config` 为准,不比较版本号。
function gitDocumentsKey(key: string): boolean {
  return execFileSync('git', ['help', '--config'], { env: ENV, encoding: 'utf8' }).split('\n').includes(key);
}

describe('config-defined hooks (hook.<name>.command / .event, git >= 2.54) ignore core.hooksPath (real git)', () => {
  const plantConfigHook = (file: string, name: string) =>
    appendFileSync(
      file,
      `[hook "${name}"]\n\tevent = post-index-change\n\tevent = post-checkout\n\tevent = reference-transaction\n\tcommand = touch "${join(markDir, name)}"\n`,
    );

  it('R46 hook.* in the repository config: restricted, detectRepoHooks reports present, guarded write ops run nothing; on a git that implements them, core.hooksPath=/dev/null alone does not stop them and the per-event switch does', async () => {
    plantConfigHook(join(repo, '.git', 'config'), 'evil');

    const guarded = realApp();
    const { guard } = installRepoSafetyGuard(guarded);
    const verdict = await guard.check(repo, { fresh: true });
    expect(verdict).toMatchObject({ kind: 'restricted', reason: 'unsafe-config' });
    expect(verdict.kind === 'restricted' && verdict.keys).toEqual(['hook.evil.event', 'hook.evil.command']);
    await runEverything(guarded);
    for (const [, op] of WRITE_OPS) expect((await op(guarded)).ok).toBe(false);
    expect(marks()).toEqual([]);

    // 守卫之外(纵深):提交前的 hooks 检测也把它算作有 hooks
    expect(await detectRepoHooks(realApp(), repo)).toEqual({
      kind: 'present',
      hooks: ['hook.evil.command', 'hook.evil.event'],
      hooksPath: null,
    });

    if (gitDocumentsKey('hook.<friendly-name>.command')) {
      // 证明缺口:只有 core.hooksPath=/dev/null(修复前的全部防护)时,git add 执行仓库 config 里的命令
      appendFileSync(join(repo, 'f.txt'), 'two\n');
      git(repo, '-c', `core.hooksPath=${DISABLED_HOOKS_PATH}`, 'add', 'f.txt');
      expect(marks()).toEqual(['evil']);
      clearMarks();
    }
    if (gitDocumentsKey('hook.<event>.enabled')) {
      // 纵深:不经守卫,仅靠固定参数里的事件开关,插件的全部读写操作也不执行它
      const unguarded = realApp();
      for (const [name, op] of WRITE_OPS) {
        git(repo, '-c', 'hook.evil.enabled=false', 'reset', '-q', '--hard');
        clearMarks();
        expect({ name, ok: (await op(unguarded)).ok }).toEqual({ name, ok: true });
        expect({ name, marks: marks() }).toEqual({ name, marks: [] });
      }
      await runEverything(unguarded);
      expect(marks()).toEqual([]);
    }
  });

  it('R47 the user\'s own config-defined hooks (global scope): repository stays trusted, no prompt before commit, and — like directory hooks under a global core.hooksPath — they do not run for stage / unstage / discard / refresh where git has the per-event switch', async () => {
    const globalCfg = join(base, 'global.cfg');
    plantConfigHook(globalCfg, 'mine');
    process.env.GIT_CONFIG_GLOBAL = globalCfg;

    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect((await guard.check(repo, { fresh: true })).kind).toBe('trusted');
    expect(await detectRepoHooks(app, repo)).toEqual({ kind: 'none' });

    if (gitDocumentsKey('hook.<event>.enabled')) {
      // fixture:不带事件开关时它确实会跑
      appendFileSync(join(repo, 'f.txt'), 'zero\n');
      execFileSync('git', ['add', 'f.txt'], { cwd: repo, env: { ...process.env } });
      expect(marks()).toEqual(['mine']);
      for (const [name, op] of WRITE_OPS) {
        execFileSync('git', ['-c', 'hook.mine.enabled=false', 'reset', '-q', '--hard'], { cwd: repo, env: { ...process.env } });
        clearMarks();
        expect({ name, ok: (await op(app)).ok }).toEqual({ name, ok: true });
        expect({ name, marks: marks() }).toEqual({ name, marks: [] });
      }
      await runEverything(app);
      expect(marks()).toEqual([]);
    }
  });
});

describe('config keys the viewer has not reviewed: default-deny for keys the running git understands (real git)', () => {
  const documentedKeys = () =>
    execFileSync('git', ['help', '--config'], { env: ENV, encoding: 'utf8' })
      .split('\n')
      .filter((l) => l !== '' && !l.includes(' ') && !l.startsWith('hasconfig:'));
  const instantiate = (key: string) => key.split('.').map((s) => (s === '*' || /^<.*>$/.test(s) ? 'x' : s)).join('.');
  /** 这个 git 文档化、但既不受限也不在分类表里的键(具体化之后)。 */
  const unreviewedKeys = () =>
    documentedKeys()
      .map(instantiate)
      .filter(
        (key) =>
          !isKnownSafeConfigKey(key) &&
          !isUnsafeConfigEntry({ scope: 'local', key, value: 'x' }) &&
          !isUnsafeConfigEntry({ scope: 'local', key, value: 'false' }),
      );
  // 分类表审计到的最新版本的键列表(随仓库保存)。比它更新的 git 可能带来还没审计的键——那正是要受限的情形。
  const reviewedUpTo = new Set(
    readFileSync(join(__dirname, '..', 'repo-safety', 'fixtures', 'git-help-config-2.56.1.txt'), 'utf8')
      .split('\n')
      .map(instantiate),
  );

  it('R48 every key the installed git documents is restricted or reviewed, except keys left unreviewed on purpose (submodule.<name>.gitdir, git >= 2.56; extension / feature names outside the reviewed ones) and keys newer than the reviewed list; each such key, set in the repository, restricts it', async () => {
    const unreviewed = unreviewedKeys();
    const onPurpose = ['submodule.x.gitdir', 'extensions.x', 'feature.x'];
    expect(unreviewed.filter((key) => reviewedUpTo.has(key) && !onPurpose.includes(key))).toEqual([]);
    expect(unreviewed).toEqual(expect.arrayContaining(['extensions.x', 'feature.x']));

    for (const key of unreviewed) {
      git(repo, 'config', key, 'x');
      const verdict = await probeRepoSafety(realApp(), repo);
      expect({ key, verdict }).toMatchObject({ key, verdict: { kind: 'restricted', reason: 'unknown-config', keys: [key.toLowerCase()] } });
      git(repo, 'config', '--unset-all', key);
    }
    expect(await probeRepoSafety(realApp(), repo)).toMatchObject({ kind: 'trusted' });
  });

  it('R49 private keys of other tools (gh, VS Code, git-flow, git-lfs, git-svn, ...) are not understood by git → trusted and fully usable; asking git (`git help --config`) starts no pager / browser / alias and no child process', async () => {
    const privateKeys = [
      'branch.main.gh-merge-base', 'remote.origin.gh-resolved', 'branch.main.vscode-merge-base', 'branch.main.github-pr-owner-number',
      'gitflow.branch.master', 'gitflow.prefix.feature', 'lfs.repositoryformatversion', 'filter.lfs.required', 'remote.origin.lfsurl',
      'svn-remote.svn.url', 'git-town.main-branch', 'sourcetree.x', 'cola.spellcheck', 'gitreview.username', 'core.longpaths', 'core.fscache',
    ];
    for (const key of privateKeys) git(repo, 'config', key, 'true');
    // help 自己的可执行配置:都不得被启动
    for (const [k, v] of Object.entries({
      'pager.help': marker('pager-help'), 'core.pager': marker('pager'), 'help.format': 'web', 'web.browser': 'x',
      'browser.x.cmd': marker('browser'), 'man.viewer': 'y', 'man.y.cmd': marker('man'), 'alias.help': `!${marker('alias-help')}`,
    })) git(repo, 'config', k, v);
    clearMarks();

    const stderr: string[] = [];
    const app = tamperedApp({ addEnv: { GIT_TRACE: '1' }, stderr });
    const { guard } = installRepoSafetyGuard(app);
    expect(await guard.check(repo, { fresh: true })).toEqual({ kind: 'trusted' });
    expect(stderr.some((s) => /trace: built-in: git help --config/.test(s))).toBe(true);
    expect(spawned(stderr)).toEqual([]);

    appendFileSync(join(repo, 'f.txt'), 'two\n');
    expect((await scanStatus(app, repo)).map((c) => c.path)).toEqual(['f.txt']);
    expect((await stageFile(app, repo, 'f.txt')).ok).toBe(true);
    expect(await gitCommit(app, repo, 'works')).toMatchObject({ ok: true });
    expect(marks()).toEqual([]);
  });
});

describe('config keys are split the way git splits them: section . subsection (anything, even nothing) . name (real git)', () => {
  const localKeys = () =>
    execFileSync('git', ['config', '--local', '--list', '--name-only', '-z'], { cwd: repo, env: ENV, encoding: 'utf8' }).split('\0').filter(Boolean);

  it.each([
    ['an empty name (`[filter ""]`, selected by `* filter=`)', ''],
    ['U+2028 in its name', 'a\u2028b'],
    ['a dotted name ending like a variable', 'x.required'],
  ])('R52 a filter driver with %s really runs on `git status`; the repository is restricted and the guarded plugin runs nothing', async (_label, driver) => {
    appendFileSync(join(repo, '.git', 'config'), `[filter "${driver}"]\n\tclean = ${marker('clean')}\n`);
    writeFileSync(join(repo, '.gitattributes'), `* filter=${driver}\n`);
    const key = `filter.${driver}.clean`;
    expect(localKeys()).toContain(key);

    // 证明 fixture:git 自己确实把它当作驱动执行
    dirty();
    git(repo, '--no-optional-locks', 'status', '--porcelain');
    expect(marks()).toEqual(['clean']);
    clearMarks();

    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect(await guard.check(repo, { fresh: true })).toMatchObject({ kind: 'restricted', reason: 'unsafe-config', keys: [key] });
    await runEverything(app);
    expect((await stageFile(app, repo, 'g.txt')).ok).toBe(false);
    expect(marks()).toEqual([]);
  });

  it('R53 a remote / branch whose name ends like another variable (`[remote "a.uploadpack"] url`, `[branch "x.remote"] merge`) is that remote\'s url, not an uploadpack key → trusted and usable; `[remote "a.url"] uploadpack` is restricted', async () => {
    appendFileSync(join(repo, '.git', 'config'), '[remote "a.uploadpack"]\n\turl = https://example.invalid/r.git\n[branch "x.remote"]\n\tmerge = refs/heads/x\n\tremote = a.uploadpack\n[branch ""]\n\tdescription = d\n');
    expect(localKeys()).toEqual(expect.arrayContaining(['remote.a.uploadpack.url', 'branch.x.remote.merge', 'branch.x.remote.remote', 'branch..description']));
    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect(await guard.check(repo, { fresh: true })).toEqual({ kind: 'trusted' });
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    expect((await scanStatus(app, repo)).map((c) => c.path)).toEqual(['f.txt']);
    expect((await stageFile(app, repo, 'f.txt')).ok).toBe(true);

    appendFileSync(join(repo, '.git', 'config'), `[remote "a.url"]\n\tuploadpack = ${marker('uploadpack')}\n`);
    expect(await guard.check(repo, { fresh: true })).toMatchObject({ kind: 'restricted', reason: 'unsafe-config', keys: ['remote.a.url.uploadpack'] });
    expect(marks()).toEqual([]);
  });

  it('R54 the keys the installed git documents, instantiated with ordinary / dotted / empty / look-alike names: the only keys both restricted and reviewed are the reviewed snapshot', () => {
    const documented = keyPatterns(execFileSync('git', ['help', '--config'], { env: ENV, encoding: 'utf8' }));
    expect(documented.length).toBeGreaterThan(900);
    expect(overlappingKeys(documented)).toEqual([...REVIEWED_OVERLAP]);
  });
});

describe('extensions: only reviewed names, and extensions.refStorage only as a format name (real git)', () => {
  it('R55 extensions.refStorage=files://<outside dir>: where git accepts it, an unguarded commit writes HEAD and a reflog line carrying the repository\'s user.name into that directory, and another repository\'s branch names are listed; guarded → restricted on every git, nothing written', async () => {
    const outside = join(realpathSync(base), 'outside-refs');
    mkdirSync(outside);
    git(repo, 'config', 'core.repositoryformatversion', '1');
    git(repo, 'config', 'user.name', 'INJECTED-NAME');
    git(repo, 'config', 'user.email', 'i@i');
    // 直接写文件:不接受这种取值的 git 设置之后连 `git config` 都会失败
    appendFileSync(join(repo, '.git', 'config'), `[extensions]\n\trefStorage = files://${outside}\n`);
    appendFileSync(join(repo, 'f.txt'), 'two\n');

    // 接受这种取值的 git(实测 2.56.1)照常工作;git 2.50 报 invalid value,包括 `git config --list` 在内的所有命令失败
    const accepted = (await gitExec(realApp(), repo, ['status', '--porcelain=v1', '-z'])).exitCode === 0;

    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    const verdict = await guard.check(repo, { fresh: true });
    if (accepted) {
      expect(verdict).toMatchObject({ kind: 'restricted', reason: 'unsafe-config', keys: ['extensions.refstorage'] });
      expect(verdict.kind === 'restricted' && verdict.message).toContain('settings that point git away from this folder');
    } else {
      expect(verdict).toMatchObject({ kind: 'restricted', reason: 'probe-failed' });
    }
    await runEverything(app);
    expect((await stageFile(app, repo, 'f.txt')).ok).toBe(false);
    expect((await gitCommit(app, repo, 'msg')).ok).toBe(false);
    expect(readdirSync(outside)).toEqual([]);

    // 证明缺口(只在接受这种取值的 git 上成立)
    if (accepted) {
      expect((await gitExec(realApp(), repo, ['add', '--', 'f.txt'])).exitCode).toBe(0);
      expect(await gitCommit(realApp(), repo, 'msg')).toMatchObject({ ok: true });
      expect(readFileSync(join(outside, 'logs', 'HEAD'), 'utf8')).toContain('INJECTED-NAME');

      const victim = join(realpathSync(base), 'victim');
      mkdirSync(victim);
      git(victim, 'init', '-q', '-b', 'main');
      git(victim, 'commit', '-q', '--allow-empty', '-m', 'v');
      git(victim, 'branch', 'secret-project-name');
      git(repo, 'config', 'extensions.refStorage', `files://${join(victim, '.git')}`);
      expect((await gitExec(realApp(), repo, ['branch', '--list'])).stdout).toContain('secret-project-name');
      expect(await guard.check(repo, { fresh: true })).toMatchObject({ kind: 'restricted', reason: 'unsafe-config' });
    }
  });

  it('R56 repositories using reviewed extensions (sha256 object format, reftable ref storage, worktreeConfig) stay trusted and fully usable; an extension name the viewer has not reviewed → restricted (unknown-config), in global config it is ignored', async () => {
    for (const init of [['--object-format=sha256'], ['--ref-format=reftable']]) {
      const dir = join(realpathSync(base), `ext${init[0]!.replace(/\W/g, '')}`);
      mkdirSync(dir);
      git(dir, 'init', '-q', '-b', 'main', ...init);
      writeFileSync(join(dir, 'f.txt'), 'one\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'init');
      git(dir, 'config', 'extensions.worktreeConfig', 'true');
      appendFileSync(join(dir, 'f.txt'), 'two\n');
      const app = realApp();
      const { guard } = installRepoSafetyGuard(app);
      expect({ init, verdict: await guard.check(dir, { fresh: true }) }).toEqual({ init, verdict: { kind: 'trusted' } });
      expect((await scanStatus(app, dir)).map((c) => c.path)).toEqual(['f.txt']);
      expect((await stageFile(app, dir, 'f.txt')).ok).toBe(true);
      expect(await gitCommit(app, dir, 'works')).toMatchObject({ ok: true });
    }

    // 版本 0 的仓库里 git 忽略不认识的扩展名(版本 1 则拒绝整个仓库);插件两种情况都不放行
    git(repo, 'config', 'extensions.futureThing', 'true');
    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const verdict = await guard.check(repo, { fresh: true });
    expect(verdict).toMatchObject({ kind: 'restricted', reason: 'unknown-config', keys: ['extensions.futurething'] });
    expect(verdict.kind === 'restricted' && verdict.message).toContain('does not recognize (extensions.futurething)');
    git(repo, 'config', '--unset', 'extensions.futureThing');

    const globalCfg = join(base, 'global.cfg');
    writeFileSync(globalCfg, '[extensions]\n\tfutureThing = true\n[feature]\n\tnewPreset = true\n');
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    expect(await guard.check(repo, { fresh: true })).toEqual({ kind: 'trusted' });
  });
});

describe('the fixed arguments are harmless on a git that predates some of them (real git)', () => {
  interface Call { readonly sub: string; readonly args: readonly string[]; readonly stderr: string; readonly exitCode: number | null }
  function recordingApp(): { app: CoPluginApp; calls: Call[] } {
    const inner = realApp();
    const calls: Call[] = [];
    const exec = async (cmd: string, args: readonly string[], opts?: PluginShellExecOptions) => {
      const r = await inner.shell.exec(cmd, args, opts);
      if (cmd === 'git') {
        // 子命令 = 全局选项(`--x`、`-c k=v`)之后的第一个词
        let i = 0;
        while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-c' ? 2 : 1;
        calls.push({ sub: args[i] ?? '', args, stderr: r.stderr, exitCode: r.exitCode });
      }
      return r;
    };
    return { app: { ...inner, shell: { exec } } as unknown as CoPluginApp, calls };
  }
  const NOISE = /^(warning|error|hint|fatal|usage)\b/im;
  const porcelain = () => git(repo, 'status', '--porcelain=v1');
  const hunkPatch = async (app: CoPluginApp, path: string, mode: 'changed' | 'staged') => {
    const d = await fetchDiff(app, repo, { path, status: 'M', statusX: mode === 'staged' ? 'M' : ' ', statusY: mode === 'staged' ? ' ' : 'M', kind: 'text' }, mode);
    if (!d.ok) throw new Error(`diff failed: ${d.message}`);
    const header = d.unifiedDiff.split('\n').findIndex((l) => l.startsWith('@@'));
    return extractHunkPatchFromUnifiedDiff(path, d.unifiedDiff, header)!;
  };

  it('R59 safety probes, refresh, stage / unstage / discard (file and hunk), commit and amend: every git call exits 0 with an empty stderr (no warning / error / hint about the 28 `-c hook.<event>.enabled=false` or any other fixed argument), and each parsed result is right', async () => {
    const { app, calls } = recordingApp();
    const { guard } = installRepoSafetyGuard(app);
    // 一个未审计、git 也不认识的私有键:让受限检测把 `git help --config` 也跑一遍
    git(repo, 'config', 'branch.main.gh-merge-base', 'main');
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    appendFileSync(join(repo, 'g.txt'), 'more\n');
    writeFileSync(join(repo, 'new.txt'), 'n\n');

    expect(await guard.check(repo, { fresh: true })).toEqual({ kind: 'trusted' });
    expect(await detectRepoHooks(app, repo)).toMatchObject({ kind: 'none' });

    // 刷新:status / numstat / hash / diff / HEAD 信息
    expect((await scanStatus(app, repo)).map((c) => [c.statusX + c.statusY, c.path, c.kind])).toEqual([
      [' M', 'f.txt', 'text'], [' M', 'g.txt', 'text'], ['??', 'new.txt', 'text'],
    ]);
    expect(await readStatusHash(app, repo)).toMatch(/\S/);
    expect(await readHeadMessage(app, repo)).toBe('init');
    expect(await hasHeadCommit(app, repo)).toBe(true);
    const diff = await fetchDiff(app, repo, { path: 'f.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' });
    expect(diff).toMatchObject({ ok: true, original: 'one\n', modified: 'one\ntwo\n' });
    expect(diff.ok && diff.unifiedDiff.split('\n').slice(2)).toEqual(['--- a/f.txt', '+++ b/f.txt', '@@ -1 +1,2 @@', ' one', '+two', '']);

    // 文件级:stage / unstage(restore --staged 与 reset 兜底两条路径)/ discard
    expect(await stageFile(app, repo, 'f.txt')).toEqual({ ok: true });
    expect(await stageFile(app, repo, 'new.txt')).toEqual({ ok: true });
    expect(porcelain()).toBe('M  f.txt\n M g.txt\nA  new.txt\n');
    _resetRestoreCache();
    expect(await unstageFile(app, repo, 'f.txt')).toEqual({ ok: true });
    // 能力探测 `restore -h`:git < 2.5x 以 129(用法说明)退出,新版本以 0 退出——两种都表示支持,真正执行的是 restore
    expect(calls.filter((c) => c.sub === 'restore').map((c) => c.args.slice(c.args.indexOf('restore')))).toEqual([['restore', '-h'], ['restore', '--staged', '--', 'f.txt']]);
    expect((await gitExec(app, repo, ['reset', 'HEAD', '--', 'new.txt'])).exitCode).toBe(0);
    expect(porcelain()).toBe(' M f.txt\n M g.txt\n?? new.txt\n');
    expect(await discardFile(app, repo, 'g.txt')).toEqual({ ok: true });
    expect(readFileSync(join(repo, 'g.txt'), 'utf8')).toBe('gee\n');

    // hunk 级:stage → unstage → discard
    expect(await stageHunk(app, repo, await hunkPatch(app, 'f.txt', 'changed'))).toMatchObject({ ok: true });
    expect(porcelain()).toBe('M  f.txt\n?? new.txt\n');
    expect(await unstageHunk(app, repo, await hunkPatch(app, 'f.txt', 'staged'))).toMatchObject({ ok: true });
    expect(porcelain()).toBe(' M f.txt\n?? new.txt\n');
    expect(await discardHunk(app, repo, await hunkPatch(app, 'f.txt', 'changed'))).toMatchObject({ ok: true });
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('one\n');

    // commit / amend
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
    expect(await stageFile(app, repo, 'new.txt')).toEqual({ ok: true });
    expect(await gitCommit(app, repo, 'second\n\nbody line')).toEqual({ ok: true });
    expect(await readLastCommitSubject(app, repo)).toBe('second');
    expect(await readHeadMessage(app, repo)).toBe('second\n\nbody line');
    const before = await readHeadSha(app, repo);
    expect(await gitCommit(app, repo, 'second, amended', { amend: true })).toEqual({ ok: true });
    expect(await readHeadMessage(app, repo)).toBe('second, amended');
    expect(await readHeadSha(app, repo)).not.toBe(before);
    expect(git(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
    expect(porcelain()).toBe('');

    // 每个子命令都真的跑过,而且带着固定参数
    expect([...new Set(calls.map((c) => c.sub))].sort()).toEqual(
      ['add', 'apply', 'cat-file', 'checkout', 'commit', 'config', 'diff', 'help', 'log', 'ls-files', 'reset', 'restore', 'rev-parse', 'status'],
    );
    const hookSwitches = (c: Call) => c.args.filter((a) => /^hook\.[a-z0-9-]+\.enabled=false$/.test(a)).length;
    expect(KNOWN_HOOK_EVENTS).toHaveLength(28);
    for (const c of calls) {
      expect({ sub: c.sub, switches: hookSwitches(c) }).toEqual({ sub: c.sub, switches: c.sub === 'commit' ? 0 : 28 });
      const exitCode = c.args[c.args.length - 1] === '-h' && c.exitCode === 129 ? 0 : c.exitCode;
      expect({ sub: c.sub, args: c.args.slice(-4), exitCode, stderr: c.stderr }).toEqual({ sub: c.sub, args: c.args.slice(-4), exitCode: 0, stderr: '' });
      expect(NOISE.test(c.stderr)).toBe(false);
    }
  });

  it('R59b the event switch is a key this git may not know: it is accepted in command scope without complaint either way, and an unknown hook event name is equally silent', async () => {
    const known = gitDocumentsKey('hook.<event>.enabled');
    const r = await realApp().shell.exec(
      'git',
      ['-c', 'hook.pre-commit.enabled=false', '-c', 'hook.post-index-change.enabled=false', '-c', 'hook.no-such-event.enabled=false', 'status', '--porcelain=v1'],
      { cwd: repo, env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' } },
    );
    expect({ known, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }).toEqual({ known, exitCode: 0, stdout: '', stderr: '' });
  });
});

describe('HEAD content of a file whose name looks like revision syntax (real git)', () => {
  // 冒号后的部分应整体是路径;`git show` 却先把整个参数按 `..` / `...` 拆成修订区间
  const NAMES = ['a..b', 'a...b', 'a@{1}', 'a^{tree}', 'a~1', 'a^', ':(top)x', '-x', '-n', '--help', 'ab:c', ':x', '@{u}', 'a b', 'd/e..b', '中文 文件.txt', 'd/名字 带 空格.md'];

  it('R50 the original pane shows the HEAD blob for every such name; `git show HEAD:a..b` (the previous command) prints a commit log instead', async () => {
    // `HEAD:a..b` 作为区间成立的条件:存在路径 a 与分支 b
    writeFileSync(join(repo, 'a'), 'plain a\n');
    mkdirSync(join(repo, 'd'));
    for (const name of NAMES) writeFileSync(join(repo, name), `HEAD content of [${name}]\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'LOG-OUTPUT-MARKER');
    git(repo, 'branch', 'b');
    for (const name of NAMES) appendFileSync(join(repo, name), 'edited\n');

    const app = realApp();
    installRepoSafetyGuard(app);

    // 证明缺陷:修复前的命令对 `a..b` 输出的是分支 b 的提交日志(带补丁),不是这个文件的内容
    const viaShow = await gitExec(app, repo, ['show', 'HEAD:a..b']);
    expect(viaShow.stdout).toMatch(/^commit [0-9a-f]{40}\n/);
    expect(viaShow.stdout).toContain('LOG-OUTPUT-MARKER');

    const changes = await scanStatus(app, repo);
    expect(changes.map((c) => c.path).sort()).toEqual([...NAMES].sort());
    // (`a:b` 这类"盘符形"名字不在此列:它不满足 isSafeRepoRelativePath,列表里是不可操作行,插件不为它运行 git——见 R60。)
    for (const change of changes) {
      const d = await fetchDiff(app, repo, change);
      expect({ path: change.path, original: d.ok && d.original, modified: d.ok && d.modified }).toEqual({
        path: change.path,
        original: `HEAD content of [${change.path}]\n`,
        modified: `HEAD content of [${change.path}]\nedited\n`,
      });
    }
  });

  it('R51 a path that is not a blob in HEAD (new file, directory) yields an empty original, never a tree listing', async () => {
    mkdirSync(join(repo, 'dir'));
    writeFileSync(join(repo, 'dir', 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'dir');
    const app = realApp();
    for (const path of ['dir', 'missing.txt']) {
      const d = await fetchDiff(app, repo, { path, status: 'M', statusX: ' ', statusY: 'M', kind: 'text' });
      expect({ path, original: d.ok && d.original }).toEqual({ path, original: '' });
    }
  });

  it('R51b a gitlink in HEAD (nested repository whose commit moved): empty original, the change itself is still shown as a submodule diff, and the nested directory is not read', async () => {
    const sub = join(repo, 'sub');
    mkdirSync(sub);
    git(sub, 'init', '-q', '-b', 'main');
    writeFileSync(join(sub, 'inner.txt'), 'INNER-CONTENT\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-qm', 'inner');
    git(repo, '-c', 'advice.addEmbeddedRepo=false', 'add', 'sub');
    git(repo, 'commit', '-qm', 'gitlink');
    git(sub, 'commit', '-q', '--allow-empty', '-m', 'inner 2');

    const app = realApp();
    const [change] = await scanStatus(app, repo);
    expect(change).toMatchObject({ path: 'sub', statusX: ' ', statusY: 'M' });
    const d = await fetchDiff(app, repo, change!);
    expect(d).toMatchObject({ ok: true, original: '', modified: '', withheld: 'not-regular' });
    expect(d.ok && d.unifiedDiff).toMatch(/^-Subproject commit [0-9a-f]{40}$/m);
    expect(JSON.stringify(d)).not.toContain('INNER-CONTENT');
  });

  it('R51c a symbolic link in HEAD: the original is the link target text git stores, never the content of the file it points to (inside or outside the folder); the working-tree side is withheld', async () => {
    const secret = join(realpathSync(base), 'secret.txt');
    writeFileSync(secret, 'OUTSIDE-SECRET\n');
    symlinkSync('f.txt', join(repo, 'inside-link'));
    symlinkSync(secret, join(repo, 'outside-link'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'links');
    // 两个链接都改了目标 → ` M`
    for (const name of ['inside-link', 'outside-link']) {
      rmSync(join(repo, name));
      symlinkSync('g.txt', join(repo, name));
    }

    const app = realApp();
    const changes = await scanStatus(app, repo);
    expect(changes.map((c) => c.path)).toEqual(['inside-link', 'outside-link']);
    const [inside, outside] = await Promise.all(changes.map((c) => fetchDiff(app, repo, c)));
    expect(inside).toMatchObject({ ok: true, original: 'f.txt', modified: '', withheld: 'symlink' });
    expect(outside).toMatchObject({ ok: true, original: secret, modified: '', withheld: 'symlink' });
    expect(JSON.stringify([inside, outside])).not.toMatch(/OUTSIDE-SECRET|one\\n|gee\\n/);
  });
});

describe('whole-file reads are size-limited (real git, host-like output cap)', () => {
  const MiB = 1024 * 1024;
  // 每行 64 字节的 ASCII 文本,恰好 bytes 字节
  const text = (bytes: number, tag: string) => `${tag}${'x'.repeat(63 - tag.length)}\n`.repeat(bytes / 64);

  it('R57 a 3 MiB tracked file with a one-line change: the diff is complete and hunk-accurate, while the two whole-file reads stop at MAX_FILE_BYTES; an untracked 3 MiB file comes back as its first 1 MiB flagged modifiedTruncated; a file of exactly the limit is not flagged', async () => {
    expect(MAX_FILE_BYTES).toBe(MiB);
    writeFileSync(join(repo, 'big.txt'), text(3 * MiB, 'big'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'big');
    appendFileSync(join(repo, 'big.txt'), 'tail line\n');
    writeFileSync(join(repo, 'new-big.log'), text(3 * MiB, 'new'));
    writeFileSync(join(repo, 'new-exact.log'), text(MiB, 'fit'));

    const app = realApp();
    installRepoSafetyGuard(app);
    const changes = await scanStatus(app, repo);
    expect(changes.map((c) => c.path)).toEqual(['big.txt', 'new-big.log', 'new-exact.log']);
    const [tracked, untracked, exact] = await Promise.all(changes.map((c) => fetchDiff(app, repo, c)));

    expect(tracked).toMatchObject({ ok: true, modifiedTruncated: true });
    if (!tracked!.ok) throw new Error('unreachable');
    expect(tracked!.unifiedDiff).toContain('\n+tail line\n');
    expect(tracked!.unifiedDiff.split('\n').length).toBeLessThan(20);
    expect(tracked!.original).toBe(text(MiB, 'big'));
    expect(tracked!.modified).toBe(text(MiB, 'big'));

    expect(untracked).toMatchObject({ ok: true, isUntracked: true, modifiedTruncated: true });
    expect(untracked!.ok && untracked!.modified).toBe(text(MiB, 'new'));

    expect(exact!.ok && exact!.modified).toBe(text(MiB, 'fit'));
    expect(exact).not.toHaveProperty('modifiedTruncated');
  });

  it('R58 a change whose unified diff exceeds the host default output limit (10 MiB) degrades to the "Diff too large" placeholder with the command to run; status and staging of that file still work', async () => {
    writeFileSync(join(repo, 'f.txt'), text(11 * MiB, 'huge'));
    const app = realApp();
    installRepoSafetyGuard(app);
    const [change] = await scanStatus(app, repo);
    expect(change).toMatchObject({ path: 'f.txt', statusY: 'M' });
    expect(await fetchDiff(app, repo, change!)).toEqual({ ok: false, reason: 'too-large', path: 'f.txt', exactCommand: 'git diff -- f.txt' });
    expect((await stageFile(app, repo, 'f.txt')).ok).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe('M  f.txt\n');
  });
});

describe('the Staged section shows what is in the index, not what is in the working tree (real git)', () => {
  const stagedBlob = (path: string) => execFileSync('git', ['cat-file', 'blob', `:0:${path}`], { cwd: repo, env: ENV, encoding: 'utf8' });
  const staged = (changes: Awaited<ReturnType<typeof scanStatus>>, path: string) => {
    const change = changes.find((c) => c.path === path);
    if (!change) throw new Error(`no status entry for ${path}`);
    return change;
  };

  it('R61 AM / AD / plain A / MM / staged rename (RM): the staged view carries exactly `git show :<path>`; the unstaged view of the same file still carries the working-tree file', async () => {
    // AM:暂存后又改;AD:暂存后从工作树删除;A:普通新增;MM:已暂存修改后再改
    writeFileSync(join(repo, 'am.txt'), 'staged\n');
    writeFileSync(join(repo, 'ad.txt'), 'staged then deleted\n');
    writeFileSync(join(repo, 'a.txt'), 'plain add\n');
    writeFileSync(join(repo, 'f.txt'), 'one\nstaged edit\n');
    git(repo, 'mv', 'g.txt', 'moved.txt');
    git(repo, 'add', '-A');
    writeFileSync(join(repo, 'am.txt'), 'other\n');
    rmSync(join(repo, 'ad.txt'));
    writeFileSync(join(repo, 'f.txt'), 'one\nstaged edit\nunstaged edit\n');
    writeFileSync(join(repo, 'moved.txt'), 'edited after the staged rename\n');
    expect(git(repo, 'status', '--porcelain')).toBe('A  a.txt\nAD ad.txt\nAM am.txt\nMM f.txt\nRM g.txt -> moved.txt\n');

    const app = realApp();
    installRepoSafetyGuard(app);
    const changes = await scanStatus(app, repo);
    const view = async (path: string, mode: 'staged' | 'changed') => {
      const d = await fetchDiff(app, repo, staged(changes, path), mode);
      if (!d.ok) throw new Error(`${path}: ${d.message}`);
      return d;
    };

    expect((await view('am.txt', 'staged')).modified).toBe('staged\n');
    expect((await view('ad.txt', 'staged')).modified).toBe('staged then deleted\n');
    expect((await view('a.txt', 'staged')).modified).toBe('plain add\n');
    expect((await view('f.txt', 'staged')).modified).toBe('one\nstaged edit\n');
    expect((await view('moved.txt', 'staged')).modified).toBe('gee\n');
    for (const path of ['am.txt', 'ad.txt', 'a.txt', 'f.txt', 'moved.txt']) {
      const d = await view(path, 'staged');
      expect({ path, modified: d.modified }).toEqual({ path, modified: stagedBlob(path) });
      expect(d).not.toHaveProperty('withheld');
    }
    // 重命名的 original 仍是 HEAD 里原路径的内容
    expect((await view('moved.txt', 'staged')).original).toBe('gee\n');

    // Changes 区(unstaged)不变:读工作树
    expect((await view('am.txt', 'changed')).modified).toBe('other\n');
    expect((await view('f.txt', 'changed')).modified).toBe('one\nstaged edit\nunstaged edit\n');
    expect((await view('moved.txt', 'changed')).modified).toBe('edited after the staged rename\n');
  });

  it('R61b the staged version is read from the object store, so it does not depend on what the path is in the working tree: a symbolic link to an outside file, a directory, nothing at all', async () => {
    const secret = join(base, 'secret.txt');
    writeFileSync(secret, 'OUTSIDE-SECRET\n');
    for (const name of ['link.txt', 'dir.txt', 'gone.txt']) writeFileSync(join(repo, name), `staged ${name}\n`);
    git(repo, 'add', '-A');
    rmSync(join(repo, 'link.txt'));
    symlinkSync(secret, join(repo, 'link.txt'));
    rmSync(join(repo, 'dir.txt'));
    mkdirSync(join(repo, 'dir.txt'));
    rmSync(join(repo, 'gone.txt'));

    const app = realApp();
    installRepoSafetyGuard(app);
    const changes = await scanStatus(app, repo);
    for (const name of ['link.txt', 'dir.txt', 'gone.txt']) {
      const d = await fetchDiff(app, repo, staged(changes, name), 'staged');
      expect({ name, modified: d.ok && d.modified, withheld: d.ok && d.withheld }).toEqual({ name, modified: `staged ${name}\n`, withheld: undefined });
    }
    // 未暂存视图读工作树:符号链接仍不读
    const link = await fetchDiff(app, repo, staged(changes, 'link.txt'), 'changed');
    expect(link).toMatchObject({ ok: true, modified: '', withheld: 'symlink' });
    expect(JSON.stringify(link)).not.toContain('OUTSIDE-SECRET');
  });

  it('R61c a staged symbolic link shows the link target text git stores; a staged gitlink and an unmerged path have no staged blob → flagged no-staged-blob instead of "(empty file)"', async () => {
    const secret = join(base, 'secret.txt');
    writeFileSync(secret, 'OUTSIDE-SECRET\n');
    symlinkSync(secret, join(repo, 'ln'));
    const sub = join(repo, 'sub');
    mkdirSync(sub);
    git(sub, 'init', '-q', '-b', 'main');
    writeFileSync(join(sub, 'inner.txt'), 'INNER-CONTENT\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-qm', 'inner');
    git(repo, '-c', 'advice.addEmbeddedRepo=false', 'add', '-A');

    const app = realApp();
    installRepoSafetyGuard(app);
    let changes = await scanStatus(app, repo);
    const ln = await fetchDiff(app, repo, staged(changes, 'ln'), 'staged');
    expect(ln).toMatchObject({ ok: true, modified: secret });
    expect(JSON.stringify(ln)).not.toContain('OUTSIDE-SECRET');
    const gitlink = await fetchDiff(app, repo, staged(changes, 'sub'), 'staged');
    expect(gitlink).toMatchObject({ ok: true, modified: '', withheld: 'no-staged-blob' });
    expect(JSON.stringify(gitlink)).not.toContain('INNER-CONTENT');

    // 冲突:两边都新增同名文件(AA)——index 里只有 stage 2 / 3,没有 stage 0
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(repo, 'both.txt'), 'theirs\n');
    git(repo, 'add', 'both.txt');
    git(repo, 'commit', '-qm', 'side');
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'both.txt'), 'ours\n');
    git(repo, 'add', 'both.txt');
    git(repo, 'commit', '-qm', 'main');
    expect(() => git(repo, 'merge', '-q', 'side')).toThrow();
    changes = await scanStatus(app, repo);
    expect(staged(changes, 'both.txt')).toMatchObject({ statusX: 'A', statusY: 'A' });
    expect(await fetchDiff(app, repo, staged(changes, 'both.txt'), 'staged')).toMatchObject({ ok: true, modified: '', withheld: 'no-staged-blob' });
  });

  // 与 R50 同一组名字,另加 `<数字>:<名字>`:`:0:x` 在 git 里是"stage 0 的 x",不是名为 `0:x` 的文件
  const NAMES = ['a..b', 'a...b', 'a@{1}', 'a^{tree}', 'a~1', 'a^', ':(top)x', '-x', '-n', '--help', 'ab:c', ':x', '@{u}', 'a b', 'd/e..b', '中文 文件.txt', 'd/名字 带 空格.md', '0:x', '2:x', 'x', '0:0:x'];

  it('R62 staged new files whose names look like revision / stage syntax: each staged view is that file\'s index blob (`0:x` is not confused with stage 0 of `x`)', async () => {
    writeFileSync(join(repo, 'a'), 'plain a\n');
    mkdirSync(join(repo, 'd'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'LOG-OUTPUT-MARKER');
    git(repo, 'branch', 'b');
    for (const name of NAMES) writeFileSync(join(repo, name), `index content of [${name}]\n`);
    git(repo, 'add', '-A');
    for (const name of NAMES) writeFileSync(join(repo, name), `working tree content of [${name}]\n`);

    const app = realApp();
    installRepoSafetyGuard(app);
    const changes = await scanStatus(app, repo);
    expect(changes.map((c) => c.path).sort()).toEqual([...NAMES].sort());
    for (const change of changes) {
      expect(change).toMatchObject({ statusX: 'A', statusY: 'M' });
      const d = await fetchDiff(app, repo, change, 'staged');
      expect({ path: change.path, original: d.ok && d.original, modified: d.ok && d.modified }).toEqual({
        path: change.path,
        original: '',
        modified: `index content of [${change.path}]\n`,
      });
    }
  });
});

describe('a status that cannot be read is an error, not "no changes" (real git)', () => {
  it('R63 corrupt index with staged content behind it: `git status` exits non-zero → scanStatus rejects with StatusUnavailableError naming git\'s message (it used to resolve to an empty list); after the index is restored the scan lists the staged file again', async () => {
    writeFileSync(join(repo, 'staged.txt'), 'will be committed\n');
    git(repo, 'add', 'staged.txt');
    const index = join(repo, '.git', 'index');
    const good = readFileSync(index);
    writeFileSync(index, 'not an index');

    const app = realApp();
    installRepoSafetyGuard(app);
    const err = await scanStatus(app, repo).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StatusUnavailableError);
    expect((err as StatusUnavailableError).message).toMatch(/^git status failed \((error|fatal): .*index/);
    expect((err as StatusUnavailableError).partial).toEqual([]);

    writeFileSync(index, good);
    expect((await scanStatus(app, repo)).map((c) => [c.path, c.statusX])).toEqual([['staged.txt', 'A']]);
  });

  it('R63b a restricted repository: the guard refuses status, and scanStatus surfaces the refusal instead of an empty list', async () => {
    git(repo, 'config', 'core.fsmonitor', marker('fsmonitor'));
    const app = realApp();
    installRepoSafetyGuard(app);
    const err = await scanStatus(app, repo).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StatusUnavailableError);
    expect((err as StatusUnavailableError).message).toContain('Git commands are disabled for this repository');
    expect(marks()).toEqual([]);
  });
});

describe('whole-file reads are time-limited (real processes)', () => {
  it('R64 a read that never finishes (the path turned into a FIFO after the file-type check): cat is terminated after FILE_READ_TIMEOUT_MS instead of the host default of 30 s, and the result is flagged like an oversized file', async () => {
    execFileSync('mkfifo', [join(repo, 'pipe.log')]);
    const app = realApp();
    // 类型检查与读取之间的时间窗:lstat 时还是普通文件
    const raced = {
      ...app,
      fs: { ...app.fs, lstat: async (p: string) => ({ ...(await app.fs.lstat(p)), isFile: true }) },
    } as unknown as CoPluginApp;

    const started = Date.now();
    const d = await fetchDiff(raced, repo, { path: 'pipe.log', status: 'U', statusX: '?', statusY: '?', kind: 'text' });
    const elapsed = Date.now() - started;

    expect(d).toMatchObject({ ok: true, modified: '', isUntracked: true, modifiedTruncated: true, modifiedTimedOut: true });
    expect(elapsed).toBeGreaterThanOrEqual(FILE_READ_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(FILE_READ_TIMEOUT_MS + 5_000);
  }, 20_000);
});

describe('config scopes: only system / global / command are trusted (real git)', () => {
  // 用真实的 system / global 配置文件(其它用例用 GIT_CONFIG_NOSYSTEM=1 + GIT_CONFIG_GLOBAL=/dev/null 把它们关掉)
  function withUserConfig<T>(fn: () => Promise<T>): Promise<T> {
    const home = join(base, 'home');
    mkdirSync(join(home, '.config', 'git'), { recursive: true });
    const prog = marker('user-owned');
    writeFileSync(join(base, 'system.cfg'), `[filter "sys"]\n\tclean = ${prog}\n[include]\n\tpath = ${join(base, 'system-inc.cfg')}\n`);
    writeFileSync(join(base, 'system-inc.cfg'), `[diff]\n\texternal = ${prog}\n`);
    writeFileSync(join(home, '.gitconfig'), `[user]\n\tname = me\n\temail = me@example.com\n[core]\n\tfsmonitor = ${prog}\n[include]\n\tpath = ${join(base, 'global-inc.cfg')}\n`);
    writeFileSync(join(base, 'global-inc.cfg'), `[filter "lfs"]\n\tclean = ${prog}\n`);
    writeFileSync(join(home, '.config', 'git', 'config'), `[gpg]\n\tprogram = ${prog}\n`);
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    delete process.env.GIT_CONFIG_NOSYSTEM;
    delete process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_SYSTEM = join(base, 'system.cfg');
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    return fn().finally(() => {
      delete process.env.GIT_CONFIG_SYSTEM;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  const KNOWN_SCOPES = ['command', 'global', 'local', 'system', 'unknown', 'worktree'];

  it('R65 the scope names the installed git really prints for system / XDG / global / included / local / worktree / command-line / environment config; an ordinary repository with all of them (the user\'s own files full of program-valued keys) stays trusted and usable', () =>
    withUserConfig(async () => {
      git(repo, 'config', 'extensions.worktreeConfig', 'true');
      git(repo, 'config', '--worktree', 'core.sparseCheckout', 'false');
      writeFileSync(join(repo, '.git', 'local-inc.cfg'), '[branch "main"]\n\tremote = origin\n');
      git(repo, 'config', 'include.path', 'local-inc.cfg');

      const app = realApp();
      const r = await app.shell.exec('git', ['-c', 'cmd.line=1', ...PROBE_ARGS], {
        cwd: repo,
        env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'env.count', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_PARAMETERS: "'env.params=1'" },
      });
      expect(r.exitCode).toBe(0);
      const entries = parseScopedConfigListStrict(r.stdout);
      if (entries === null) throw new Error('malformed config output');
      const scopeOf = (key: string) => entries.filter((e) => e.key === key).map((e) => e.scope);
      expect({
        'filter.sys.clean': scopeOf('filter.sys.clean'),
        'diff.external': scopeOf('diff.external'),
        'gpg.program': scopeOf('gpg.program'),
        'user.name': scopeOf('user.name'),
        'filter.lfs.clean': scopeOf('filter.lfs.clean'),
        'core.bare': scopeOf('core.bare'),
        'branch.main.remote': scopeOf('branch.main.remote'),
        'core.sparsecheckout': scopeOf('core.sparsecheckout'),
        'cmd.line': scopeOf('cmd.line'),
        'env.count': scopeOf('env.count'),
        'env.params': scopeOf('env.params'),
      }).toEqual({
        'filter.sys.clean': ['system'],
        'diff.external': ['system'], // include 进来的文件沿用引入者的作用域
        'gpg.program': ['global'], // $XDG_CONFIG_HOME/git/config
        'user.name': ['global'],
        'filter.lfs.clean': ['global'],
        'core.bare': ['local'],
        'branch.main.remote': ['local'],
        'core.sparsecheckout': ['worktree'],
        'cmd.line': ['command'],
        'env.count': ['command'],
        'env.params': ['command'],
      });

      // 这个 git 输出的全部作用域名都是已知的;system / global / command 之外的只有 local / worktree,
      // 以及 Apple Git 把 Xcode 自带的 gitconfig 报告成的 `unknown`
      const scopes = [...new Set(entries.map((e) => e.scope))].sort();
      expect(scopes.filter((scope) => !KNOWN_SCOPES.includes(scope))).toEqual([]);
      expect(scopes).toEqual(expect.arrayContaining(['command', 'global', 'local', 'system', 'worktree']));
      expect(scopes.filter(isRepoControlledScope).filter((scope) => scope !== 'unknown')).toEqual(['local', 'worktree']);
      // `unknown` 里的键(若有)都是已审计的普通键:不会让普通仓库受限
      const bundled = entries.filter((e) => e.scope === 'unknown');
      expect(bundled.filter((e) => isUnsafeConfigEntry(e) || !isKnownSafeConfigKey(e.key))).toEqual([]);

      // 用户自己的 system / global 里全是可执行键,仓库照样可信、可用,且这些程序一个都不会被插件启动
      clearMarks();
      expect(await probeRepoSafety(app, repo)).toMatchObject({ kind: 'trusted' });
      installRepoSafetyGuard(app);
      appendFileSync(join(repo, 'f.txt'), 'two\n');
      expect((await scanStatus(app, repo)).map((c) => c.path)).toEqual(['f.txt']);
      expect((await stageFile(app, repo, 'f.txt')).ok).toBe(true);
      expect(marks()).toEqual([]);
    }));

  it('R65b a plain repository under the real system configuration (on Apple Git this includes the bundled `unknown`-scope defaults): trusted and cacheable; the same executable key in the repository restricts it', () =>
    withUserConfig(async () => {
      const app = realApp();
      expect(await probeRepoSafety(app, repo)).toEqual({ kind: 'trusted', cacheable: true });
      git(repo, 'config', 'filter.x.clean', marker('repo-filter'));
      expect(await probeRepoSafety(app, repo)).toMatchObject({ kind: 'restricted', reason: 'unsafe-config', keys: ['filter.x.clean'] });
    }));
});

// macOS:仓库 config 里的 core.precomposeUnicode=true(`git init` 默认写入)让 git 把命令行参数与读目录得到的
// 名字转成预组合形式(NFC),index 里的名字不转换。其它平台的 git 不读这个键,文件系统也区分两种形式——
// 下面的断言在两类平台上都成立("每个操作作用于 status 列出的那个条目");只有 fixture 证明(去掉固定参数后
// 出错)以"这个 git 确实改写参数"为前提。
describe('file names reach git byte for byte whatever core.precomposeUnicode says (real git)', () => {
  const NFC = 'café.txt';
  const NFD = 'café.txt';
  // 不做任何转换的 git(测试自己读写 index 用)
  const raw = (...args: string[]) => git(repo, '-c', 'core.precomposeUnicode=false', ...args);
  const indexNames = () => raw('ls-files', '-z').split('\0').filter(Boolean).sort();
  const indexBlob = (name: string) => raw('cat-file', 'blob', `:0:${name}`);
  const headBlob = (name: string) => raw('cat-file', 'blob', `HEAD:${name}`);
  const blobOf = (content: string) =>
    execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content, env: ENV, encoding: 'utf8' }).trim();
  /** 这个 git 在 core.precomposeUnicode=true 时改写命令行参数(macOS)。 */
  const rewritesArgv = () => {
    const probe = blobOf('probe\n');
    const idx = join(base, 'probe-index');
    const env = { ...ENV, GIT_INDEX_FILE: idx };
    execFileSync('git', ['-c', 'core.precomposeUnicode=false', 'update-index', '--add', '--cacheinfo', `100644,${probe},${NFD}`], { cwd: repo, env });
    try {
      execFileSync('git', ['-c', 'core.precomposeUnicode=true', 'cat-file', '-e', `:0:${NFD}`], { cwd: repo, env, stdio: 'ignore' });
      return false;
    } catch {
      return true;
    } finally {
      rmSync(idx, { force: true });
    }
  };
  const noPin = () => tamperedApp({ dropPins: LITERAL_ARGV_CONFIG.map(([k]) => k) });
  const entry = (changes: Awaited<ReturnType<typeof scanStatus>>, path: string) => {
    const change = changes.find((c) => c.path === path);
    if (!change) throw new Error(`no status entry for ${JSON.stringify(path)} in ${JSON.stringify(changes.map((c) => c.path))}`);
    return change;
  };
  const okDiff = async (app: CoPluginApp, change: Awaited<ReturnType<typeof scanStatus>>[number], mode: 'staged' | 'changed') => {
    const d = await fetchDiff(app, repo, change, mode);
    if (!d.ok) throw new Error(`${change.path}: ${d.message}`);
    return d;
  };

  beforeEach(() => {
    git(repo, 'config', 'core.precomposeUnicode', 'true');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
  });

  it('R66 an index entry with an NFD name (`MM`): the Staged view shows its index blob, both diffs are non-empty, stage / unstage / discard (file and hunk) change that entry and create no second one, and the commit contains what was shown; without the pin the staged content is unreadable while the commit still goes through', async () => {
    // index 条目按 NFD 名建立(旧 mac 仓库 / Linux 上提交 / 压缩包带来的)
    raw('update-index', '--add', '--cacheinfo', `100644,${blobOf('one\n')},${NFD}`);
    raw('commit', '-qm', 'nfd entry');
    writeFileSync(join(repo, NFD), 'one\ntwo\n');
    raw('add', '--', NFD);
    writeFileSync(join(repo, NFD), 'one\ntwo\nthree\n');
    expect(indexNames()).toEqual(['f.txt', 'g.txt', NFD].sort());

    const app = realApp();
    const { guard } = installRepoSafetyGuard(app);
    expect((await guard.check(repo, { fresh: true })).kind).toBe('trusted');
    let changes = await scanStatus(app, repo);
    expect(entry(changes, NFD)).toMatchObject({ statusX: 'M', statusY: 'M' });

    const staged = await okDiff(app, entry(changes, NFD), 'staged');
    expect(staged).not.toHaveProperty('withheld');
    expect(staged.modified).toBe('one\ntwo\n');
    expect(staged.original).toBe('one\n');
    expect(staged.unifiedDiff).toContain('+two');
    expect(staged.unifiedDiff).not.toContain('+three');
    const unstaged = await okDiff(app, entry(changes, NFD), 'changed');
    expect(unstaged.modified).toBe('one\ntwo\nthree\n');
    expect(unstaged.unifiedDiff).toContain('+three');

    if (rewritesArgv()) {
      // fixture 证明:不固定时参数被改成 NFC——index 里没有这个名字
      const loose = await okDiff(noPin(), entry(changes, NFD), 'staged');
      expect(loose).toMatchObject({ modified: '', unifiedDiff: '' });
      expect(loose.withheld).toBeDefined();
      expect((await stageFile(noPin(), repo, NFD)).ok).toBe(true);
      expect(indexNames()).toEqual(['f.txt', 'g.txt', NFD, NFC].sort());
      raw('rm', '-q', '--cached', '--', NFC);
    }

    // stage:更新的是 NFD 条目,不新增条目
    expect(await stageFile(app, repo, NFD)).toEqual({ ok: true });
    expect(indexNames()).toEqual(['f.txt', 'g.txt', NFD].sort());
    expect(indexBlob(NFD)).toBe('one\ntwo\nthree\n');
    // unstage(restore --staged 与 reset 兜底)
    _resetRestoreCache();
    expect(await unstageFile(app, repo, NFD)).toEqual({ ok: true });
    expect(indexBlob(NFD)).toBe('one\n');
    raw('add', '--', NFD);
    expect((await gitExec(app, repo, ['reset', 'HEAD', '--', NFD])).exitCode).toBe(0);
    expect(indexBlob(NFD)).toBe('one\n');
    expect(indexNames()).toEqual(['f.txt', 'g.txt', NFD].sort());

    // hunk 级:补丁里的路径来自 diff 输出(NFD),按原样匹配 index
    changes = await scanStatus(app, repo);
    const d = await okDiff(app, entry(changes, NFD), 'changed');
    const lines = d.unifiedDiff.split('\n');
    const patch = extractHunkPatchFromUnifiedDiff(NFD, d.unifiedDiff, lines.findIndex((l) => l.startsWith('@@')));
    expect(await stageHunk(app, repo, patch!)).toMatchObject({ ok: true });
    expect(indexBlob(NFD)).toBe('one\ntwo\nthree\n');
    expect(await unstageHunk(app, repo, patch!)).toMatchObject({ ok: true });
    expect(indexBlob(NFD)).toBe('one\n');
    expect(await discardHunk(app, repo, patch!)).toMatchObject({ ok: true });
    expect(readFileSync(join(repo, NFD), 'utf8')).toBe('one\n');

    // discard(文件级):工作树回到 index 版本
    writeFileSync(join(repo, NFD), 'one\ntwo\n');
    raw('add', '--', NFD);
    writeFileSync(join(repo, NFD), 'scratch\n');
    expect(await discardFile(app, repo, NFD)).toEqual({ ok: true });
    expect(readFileSync(join(repo, NFD), 'utf8')).toBe('one\ntwo\n');

    // 提交的正是 Staged 区显示的内容
    changes = await scanStatus(app, repo);
    const shown = await okDiff(app, entry(changes, NFD), 'staged');
    expect(await gitCommit(app, repo, 'commit nfd')).toMatchObject({ ok: true });
    expect(headBlob(NFD)).toBe(shown.modified);
    expect(indexNames()).toEqual(['f.txt', 'g.txt', NFD].sort());
  });

  it('R67 an ordinary repository whose files have decomposed names on disk (Finder-style: accented Latin, Hangul jamo): the list has no phantom untracked row, an untracked file is staged by the name status reported, and viewing / unstaging / modifying / discarding it keeps working', async () => {
    const HANGUL_NFD = '한글.txt';
    // 磁盘上是分解形式的名字;status / add 按仓库设置读目录(macOS 上报告并记录为 NFC)
    writeFileSync(join(repo, NFD), 'tracked\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'tracked decomposed-on-disk file');
    const trackedName = git(repo, 'ls-files', '-z').split('\0').filter((n) => n && n !== 'f.txt' && n !== 'g.txt');
    expect(trackedName).toHaveLength(1);
    appendFileSync(join(repo, NFD), 'edited\n');
    writeFileSync(join(repo, HANGUL_NFD), 'new\n');

    const app = realApp();
    installRepoSafetyGuard(app);
    let changes = await scanStatus(app, repo);
    // 恰好两条:已跟踪文件的修改 + 一个未跟踪文件。固定 status 的 precomposeUnicode=false 时,macOS 上
    // 已跟踪文件会多出一条 `??`(磁盘名与 index 名的形式不同)。
    expect(changes.map((c) => `${c.statusX}${c.statusY}`).sort()).toEqual([' M', '??']);
    expect(changes.find((c) => c.statusY === 'M')!.path).toBe(trackedName[0]);
    // 指纹里 `# branch.…` 开头的是头行(HEAD / 分支),其余每条记录一个条目
    expect((await readStatusHash(app, repo)).split('\0').filter((record) => record !== '' && !record.startsWith('# '))).toHaveLength(2);
    const tracked = changes.find((c) => c.statusY === 'M')!;
    const untracked = changes.find((c) => c.statusX === '?')!;
    expect(untracked.path.normalize('NFC')).toBe(HANGUL_NFD.normalize('NFC'));

    // 已跟踪文件:查看 / 暂存 / 取消 / 丢弃
    const d = await okDiff(app, tracked, 'changed');
    expect(d.unifiedDiff).toContain('+edited');
    expect(d.modified).toBe('tracked\nedited\n');
    expect(await stageFile(app, repo, tracked.path)).toEqual({ ok: true });
    expect(indexBlob(tracked.path)).toBe('tracked\nedited\n');
    expect(await unstageFile(app, repo, tracked.path)).toEqual({ ok: true });
    expect(indexBlob(tracked.path)).toBe('tracked\n');
    expect(await discardFile(app, repo, tracked.path)).toEqual({ ok: true });
    expect(readFileSync(join(repo, NFD), 'utf8')).toBe('tracked\n');

    // 未跟踪文件:内容可见;按 status 报告的名字暂存(面板对 `??` 行传 untracked: true)
    expect((await okDiff(app, untracked, 'changed')).modified).toBe('new\n');
    expect(await stageFile(app, repo, untracked.path, { untracked: true })).toEqual({ ok: true });
    changes = await scanStatus(app, repo);
    expect(changes.map((c) => `${c.statusX}${c.statusY} ${c.path}`)).toEqual([`A  ${untracked.path}`]);
    expect(indexBlob(untracked.path)).toBe('new\n');
    expect((await okDiff(app, entry(changes, untracked.path), 'staged')).modified).toBe('new\n');

    if (rewritesArgv()) {
      // fixture 证明:对未跟踪路径也固定 false 时,git add 以 0 退出却什么都没暂存
      raw('rm', '-q', '--cached', '--', untracked.path);
      expect(await stageFile(app, repo, untracked.path)).toEqual({ ok: true });
      expect(indexNames()).not.toContain(untracked.path);
      expect(await stageFile(app, repo, untracked.path, { untracked: true })).toEqual({ ok: true });
      expect(indexNames()).toContain(untracked.path);
    }

    // 暂存后的新文件再改:Changes 区的增量、文件级暂存、取消暂存都作用于同一条目
    appendFileSync(join(repo, HANGUL_NFD), 'more\n');
    changes = await scanStatus(app, repo);
    expect(changes.map((c) => `${c.statusX}${c.statusY} ${c.path}`)).toEqual([`AM ${untracked.path}`]);
    expect(await stageFile(app, repo, untracked.path)).toEqual({ ok: true });
    expect(indexBlob(untracked.path)).toBe('new\nmore\n');
    expect(await unstageFile(app, repo, untracked.path)).toEqual({ ok: true });
    changes = await scanStatus(app, repo);
    expect(changes.map((c) => `${c.statusX}${c.statusY} ${c.path}`)).toEqual([`?? ${untracked.path}`]);
  });

  it('R68 the index holds both an NFC and an NFD entry of the same name: each row is viewed, staged, unstaged and discarded on its own entry', async () => {
    raw('update-index', '--add', '--cacheinfo', `100644,${blobOf('nfc v1\n')},${NFC}`);
    raw('update-index', '--add', '--cacheinfo', `100644,${blobOf('nfd v1\n')},${NFD}`);
    raw('commit', '-qm', 'both forms');
    // 规范化不敏感的文件系统(APFS / HFS+)上两个名字是同一个文件;敏感的文件系统上是两个文件
    writeFileSync(join(repo, NFC), 'disk nfc\n');
    writeFileSync(join(repo, NFD), 'disk nfd\n');
    const disk = (name: string) => readFileSync(join(repo, name), 'utf8');

    const app = realApp();
    installRepoSafetyGuard(app);
    let changes = await scanStatus(app, repo);
    expect(entry(changes, NFC)).toMatchObject({ statusX: ' ', statusY: 'M' });
    expect(entry(changes, NFD)).toMatchObject({ statusX: ' ', statusY: 'M' });

    for (const [name, other, v1] of [[NFD, NFC, 'nfd v1\n'], [NFC, NFD, 'nfc v1\n']] as const) {
      const otherBlob = indexBlob(other);
      const changed = await okDiff(app, entry(changes, name), 'changed');
      expect(changed.original).toBe(v1);
      expect(changed.unifiedDiff).toContain(`-${v1.trim()}`);
      expect(changed.unifiedDiff).toContain(`+${disk(name).trim()}`);

      expect(await stageFile(app, repo, name)).toEqual({ ok: true });
      expect(indexBlob(name)).toBe(disk(name));
      expect(indexBlob(other)).toBe(otherBlob);
      const staged = await okDiff(app, entry(await scanStatus(app, repo), name), 'staged');
      expect(staged.modified).toBe(disk(name));
      expect(staged).not.toHaveProperty('withheld');

      expect(await unstageFile(app, repo, name)).toEqual({ ok: true });
      expect(indexBlob(name)).toBe(v1);
      expect(indexBlob(other)).toBe(otherBlob);
      expect(indexNames()).toEqual(['f.txt', 'g.txt', NFC, NFD].sort());
    }

    // discard:工作树文件回到**这个**条目的 index 版本
    changes = await scanStatus(app, repo);
    expect(await discardFile(app, repo, entry(changes, NFD).path)).toEqual({ ok: true });
    expect(disk(NFD)).toBe('nfd v1\n');
    expect(indexBlob(NFC)).toBe('nfc v1\n');
    writeFileSync(join(repo, NFC), 'disk again\n');
    expect(await discardFile(app, repo, NFC)).toEqual({ ok: true });
    expect(disk(NFC)).toBe('nfc v1\n');
  });
});

describe('a staged version that cannot be read is not blamed on a submodule or a conflict (real git)', () => {
  // 只让"读 index 版本"这一条命令失败(进程被杀 / 对象读不到的替身),其余命令照常交给真实 git
  const failingIndexRead = (inner: CoPluginApp = realApp()): CoPluginApp => {
    const exec = inner.shell.exec.bind(inner.shell);
    return {
      ...inner,
      shell: {
        exec: async (cmd: string, args: readonly string[], opts?: PluginShellExecOptions) =>
          cmd === 'git' && args.includes('cat-file') && args.some((a) => a.startsWith(':0:'))
            ? { stdout: '', stderr: 'fatal: unable to read', exitCode: 128, signal: null, timedOut: false, truncated: false }
            : exec(cmd, args, opts),
      },
    } as unknown as CoPluginApp;
  };

  it('R69 with the index read failing: a regular staged file, a staged symbolic link and a staged file inside a directory are flagged staged-unreadable; a gitlink (real `ls-files -s` mode 160000) and an unmerged path keep no-staged-blob; in a restricted repository the refusal itself is reported', async () => {
    writeFileSync(join(repo, 'new.txt'), 'staged new\n');
    symlinkSync('f.txt', join(repo, 'ln'));
    mkdirSync(join(repo, 'dir'));
    writeFileSync(join(repo, 'dir', 'inner.txt'), 'inner\n');
    const sub = join(repo, 'sub');
    mkdirSync(sub);
    git(sub, 'init', '-q', '-b', 'main');
    writeFileSync(join(sub, 'x.txt'), 'x\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-qm', 'inner');
    git(repo, '-c', 'advice.addEmbeddedRepo=false', 'add', '-A');

    const app = failingIndexRead();
    installRepoSafetyGuard(app);
    let changes = await scanStatus(app, repo);
    const withheld = async (path: string) => {
      const d = await fetchDiff(app, repo, changes.find((c) => c.path === path)!, 'staged');
      return d.ok ? d.withheld : d;
    };
    expect(await withheld('new.txt')).toBe('staged-unreadable');
    expect(await withheld('ln')).toBe('staged-unreadable');
    expect(await withheld('dir/inner.txt')).toBe('staged-unreadable');
    expect(await withheld('sub')).toBe('no-staged-blob');
    // 同一仓库、读取正常时:普通文件照常显示(不带标记)
    const fine = await fetchDiff(realApp(), repo, changes.find((c) => c.path === 'new.txt')!, 'staged');
    expect(fine).toMatchObject({ ok: true, modified: 'staged new\n' });
    expect(fine).not.toHaveProperty('withheld');

    // 未合并(UU):status 已说明
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(repo, 'f.txt'), 'theirs\n');
    git(repo, 'commit', '-qam', 'side');
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'f.txt'), 'ours\n');
    git(repo, 'commit', '-qam', 'main');
    expect(() => git(repo, 'merge', '-q', 'side')).toThrow();
    changes = await scanStatus(app, repo);
    expect(changes.find((c) => c.path === 'f.txt')).toMatchObject({ statusX: 'U', statusY: 'U' });
    expect(await withheld('f.txt')).toBe('no-staged-blob');

    // 受限仓库:守卫拒绝的是所有命令——显示的是拒绝原因,不是"子模块或冲突"
    const stale = changes.find((c) => c.path === 'f.txt')!;
    git(repo, 'config', 'core.fsmonitor', marker('fsmonitor'));
    const restricted = realApp();
    const { guard } = installRepoSafetyGuard(restricted);
    expect((await guard.check(repo, { fresh: true })).kind).toBe('restricted');
    const refused = await fetchDiff(restricted, repo, { ...stale, statusX: 'A', statusY: ' ' }, 'staged');
    expect(refused).toMatchObject({ ok: false, reason: 'git-error' });
    expect(JSON.stringify(refused)).toMatch(/disabled for this repository/);
    expect(marks()).toEqual([]);
  });
});

// 面板对一行的呈现:按 (change, 区) 取 diff,再渲染 DiffView(静态标记,足以区分全文视图 / unified diff / hunk 按钮)
const rendered = async (app: CoPluginApp, change: Awaited<ReturnType<typeof scanStatus>>[number], mode: 'staged' | 'changed') => {
  const diff = await fetchDiff(app, repo, change, mode);
  const html = renderToStaticMarkup(createElement(DiffView, { store: createGitStore(), change, diff, mode }));
  const text = (cls: string) =>
    [...html.matchAll(new RegExp(`<div class="cgv-line ${cls}"[^>]*><span class="cgv-line-num">[^<]*</span><span class="cgv-line-text">([^<]*)</span>`, 'g'))].map((m) => m[1]);
  return {
    diff,
    html,
    whole: /<pre class="cgv-new-file">([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? null,
    added: text('cgv-line-add'),
    removed: text('cgv-line-del'),
    buttons: [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]),
  };
};

describe('each section shows its own side of a file that is in both (real git)', () => {
  it('R70 AM / AD / MM / staged new symbolic link / untracked: Staged shows the index version (whole file for a new entry), Changes shows the index → working-tree increment with working hunk actions, a deletion is a deletion, and a link is labelled as one', async () => {
    const secret = join(base, 'secret.txt');
    writeFileSync(secret, 'OUTSIDE-SECRET\n');
    writeFileSync(join(repo, 'am.txt'), 'staged 1\nstaged 2\n');
    writeFileSync(join(repo, 'ad.txt'), 'staged then deleted\n');
    writeFileSync(join(repo, 'f.txt'), 'one\nstaged edit\n');
    symlinkSync(secret, join(repo, 'ln'));
    git(repo, 'add', '-A');
    writeFileSync(join(repo, 'am.txt'), 'staged 1\nstaged 2\nlater\n');
    rmSync(join(repo, 'ad.txt'));
    writeFileSync(join(repo, 'f.txt'), 'one\nstaged edit\nunstaged edit\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    expect(git(repo, 'status', '--porcelain')).toBe('AD ad.txt\nAM am.txt\nMM f.txt\nA  ln\n?? new.txt\n');

    const app = realApp();
    installRepoSafetyGuard(app);
    const changes = await scanStatus(app, repo);
    const row = (path: string) => changes.find((c) => c.path === path)!;

    // AM
    const amStaged = await rendered(app, row('am.txt'), 'staged');
    expect(amStaged).toMatchObject({ whole: 'staged 1\nstaged 2\n', added: [], buttons: [] });
    const amChanged = await rendered(app, row('am.txt'), 'changed');
    expect(amChanged).toMatchObject({ whole: null, added: ['+later'], removed: [], buttons: ['Stage', 'Discard'] });
    expect(amChanged.diff.ok && amChanged.diff.unifiedDiff).toBe(git(repo, 'diff', '--', 'am.txt'));

    // AD:Changes 区是工作树删除,不是 "(empty file)"
    const adStaged = await rendered(app, row('ad.txt'), 'staged');
    expect(adStaged.whole).toBe('staged then deleted\n');
    const adChanged = await rendered(app, row('ad.txt'), 'changed');
    expect(adChanged).toMatchObject({ whole: null, added: [], removed: ['-staged then deleted'], buttons: [] });
    expect(adChanged.html).not.toContain('(empty file)');
    expect(adChanged.html).toContain('deleted file mode 100644');

    // MM:两个区各是各的增量
    expect(await rendered(app, row('f.txt'), 'staged')).toMatchObject({ whole: null, added: ['+staged edit'], buttons: ['Unstage'] });
    expect(await rendered(app, row('f.txt'), 'changed')).toMatchObject({ whole: null, added: ['+unstaged edit'], buttons: ['Stage', 'Discard'] });

    // 暂存的新符号链接:标明是链接;目标路径不当成文件内容,外部文件内容不出现
    const ln = await rendered(app, row('ln'), 'staged');
    expect(ln.diff).toMatchObject({ ok: true, modified: secret, modifiedIsSymlink: true });
    expect(ln.whole).toBeNull();
    expect(ln.html).toContain(`<div class="cgv-symlink-note" role="note">Symbolic link → ${secret}</div>`);
    expect(ln.html).not.toContain('OUTSIDE-SECRET');
    // 普通新文件不带这个标记
    expect(amStaged.diff).not.toHaveProperty('modifiedIsSymlink');

    // 未跟踪:工作树全文
    expect(await rendered(app, row('new.txt'), 'changed')).toMatchObject({ whole: 'untracked\n', buttons: [] });

    // AM 的 hunk 操作对真实 git 成立:暂存这个 hunk → index 得到增量;取消后丢弃 → 工作树回到 index 版本
    const d = amChanged.diff;
    if (!d.ok) throw new Error('am.txt diff failed');
    const patch = extractHunkPatchFromUnifiedDiff('am.txt', d.unifiedDiff, d.unifiedDiff.split('\n').findIndex((l) => l.startsWith('@@')));
    expect(await stageHunk(app, repo, patch!)).toMatchObject({ ok: true });
    expect(git(repo, 'show', ':am.txt')).toBe('staged 1\nstaged 2\nlater\n');
    expect(git(repo, 'status', '--porcelain', '--', 'am.txt')).toBe('A  am.txt\n');
    expect(await unstageHunk(app, repo, patch!)).toMatchObject({ ok: true });
    expect(git(repo, 'status', '--porcelain', '--', 'am.txt')).toBe('AM am.txt\n');
    expect(await discardHunk(app, repo, patch!)).toMatchObject({ ok: true });
    expect(readFileSync(join(repo, 'am.txt'), 'utf8')).toBe('staged 1\nstaged 2\n');
    expect(git(repo, 'status', '--porcelain', '--', 'am.txt')).toBe('A  am.txt\n');
  });
});

describe('one path, two status records: `git rm --cached` leaves `D  f` and `?? f` (real git)', () => {
  it('R71 both rows exist; selecting the untracked one shows the file still on disk, selecting the staged one shows the deletion, a refresh keeps the selection, and staging the untracked row folds the two back into nothing', async () => {
    git(repo, 'rm', '-q', '--cached', 'f.txt');
    expect(git(repo, 'status', '--porcelain')).toBe('D  f.txt\n?? f.txt\n');

    const app = realApp();
    installRepoSafetyGuard(app);
    const store = createGitStore({
      load: async () => ({ repoRoot: repo, changes: await scanStatus(app, repo) }),
      fetchDiff: (root, change, mode) => fetchDiff(app, root, change, mode),
    });
    await store.getState().refresh();
    expect(store.getState().changes.map((c) => `${c.statusX}${c.statusY} ${c.path}`)).toEqual(['D  f.txt', '?? f.txt']);
    const shown = async (mode: 'staged' | 'changed') => {
      store.getState().selectFile('f.txt', mode);
      await store.getState().loadDiff('f.txt', mode);
      const { selected, diffCache } = store.getState();
      return diffCache.get(`${selected!.mode}:${selected!.path}`);
    };

    expect(await shown('changed')).toMatchObject({ ok: true, isUntracked: true, modified: 'one\n' });
    const staged = await shown('staged');
    expect(staged).toMatchObject({ ok: true, isUntracked: false, original: 'one\n', modified: '' });
    expect(staged?.ok && staged.unifiedDiff).toContain('deleted file mode 100644');

    // 刷新:选中的未跟踪行不跳到 Staged 区,内容仍是工作树文件
    store.getState().selectFile('f.txt', 'changed');
    await store.getState().refresh();
    expect(store.getState().selected).toEqual({ path: 'f.txt', mode: 'changed' });
    await store.getState().loadDiff('f.txt', 'changed');
    expect(store.getState().diffCache.get('changed:f.txt')).toMatchObject({ ok: true, isUntracked: true, modified: 'one\n' });

    // 暂存未跟踪那一行(面板对 `??` 行的调用方式)→ 与 HEAD 相同,两条记录都消失
    expect(await stageFile(app, repo, 'f.txt', { untracked: true })).toEqual({ ok: true });
    await store.getState().refresh();
    expect(store.getState().changes).toEqual([]);
    expect(store.getState().selected).toBeNull();
  });
});

describe('a type change (file ↔ symbolic link) is one entry replaced by another, never hunks of one file (real git)', () => {
  const lsFiles = (path: string) => git(repo, 'ls-files', '-s', '--', path).split('\t')[0];
  const hunkIndexes = (unifiedDiff: string) =>
    unifiedDiff.split('\n').map((l, i) => (l.startsWith('@@') ? i : -1)).filter((i) => i >= 0);

  it('R72 AT / ` T` (both directions) / `T ` / MT keep their status code, show the deletion + addition without hunk buttons and yield no hunk patch; file-level stage / unstage / discard act on the entry and keep its content; chmod + edit still has working hunk actions', async () => {
    writeFileSync(join(repo, 'base'), 'base\n');
    writeFileSync(join(repo, 'mt'), 'two\n');
    writeFileSync(join(repo, 'ch.sh'), 'x\n');
    symlinkSync('base', join(repo, 'lnk'));
    symlinkSync('base', join(repo, 'l2'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'more');
    const toLink = (name: string) => {
      rmSync(join(repo, name));
      symlinkSync('base', join(repo, name));
    };
    const toFile = (name: string, content: string) => {
      rmSync(join(repo, name));
      writeFileSync(join(repo, name), content);
    };
    // AT:暂存的新文件,之后工作树里换成符号链接
    writeFileSync(join(repo, 'at'), 'content\n');
    git(repo, 'add', 'at');
    toLink('at');
    toLink('f.txt'); // ` T` 文件 → 链接
    toFile('l2', 'now a file\n'); // ` T` 链接 → 文件
    toFile('lnk', 'staged file\n'); // `T ` 链接 → 文件,已暂存
    git(repo, 'add', 'lnk');
    writeFileSync(join(repo, 'mt'), 'two2\n'); // MT
    git(repo, 'add', 'mt');
    toLink('mt');
    chmodSync(join(repo, 'ch.sh'), 0o755); // chmod + 内容修改:不是类型变更
    appendFileSync(join(repo, 'ch.sh'), 'y\n');
    expect(git(repo, 'status', '--porcelain')).toBe('AT at\n M ch.sh\n T f.txt\n T l2\nT  lnk\nMT mt\n');

    const app = realApp();
    installRepoSafetyGuard(app);
    const scan = async () => (await scanStatus(app, repo)).map((c) => `${c.statusX}${c.statusY} ${c.path}`);
    const changes = await scanStatus(app, repo);
    expect(await scan()).toEqual(['AT at', ' M ch.sh', ' T f.txt', ' T l2', 'T  lnk', 'MT mt']);
    const row = (path: string) => changes.find((c) => c.path === path)!;

    // Changes 区的类型变更:两段(删除 + 新增)都显示,没有 hunk 按钮,也构造不出 hunk 补丁
    for (const path of ['at', 'f.txt', 'l2', 'mt']) {
      const view = await rendered(app, row(path), 'changed');
      if (!view.diff.ok) throw new Error(`${path}: diff failed`);
      expect(view.diff.unifiedDiff, path).toBe(git(repo, 'diff', '--', path));
      expect(view.diff.unifiedDiff.match(/^diff --git /gm), path).toHaveLength(2);
      expect(view.html, path).toContain('deleted file mode');
      expect(view.html, path).toContain('new file mode');
      expect(view.buttons, path).toEqual([]);
      const hunks = hunkIndexes(view.diff.unifiedDiff);
      expect(hunks, path).toHaveLength(2);
      for (const i of hunks) expect(extractHunkPatchFromUnifiedDiff(path, view.diff.unifiedDiff, i), path).toBeNull();
    }
    // Staged 区:`T ` 同样;`AT` 是新条目的 index 全文;`MT` 的暂存一侧是普通修改,Unstage hunk 照常
    const lnkStaged = await rendered(app, row('lnk'), 'staged');
    expect(lnkStaged.buttons).toEqual([]);
    expect(lnkStaged.html).toContain('deleted file mode 120000');
    expect(lnkStaged.added).toEqual(['+staged file']);
    expect((await rendered(app, row('at'), 'staged')).whole).toBe('content\n');
    expect(await rendered(app, row('mt'), 'staged')).toMatchObject({ added: ['+two2'], removed: ['-two'], buttons: ['Unstage'] });

    // 文件级操作可用
    for (const path of ['at', 'f.txt', 'l2', 'mt']) {
      expect(canStageFile(row(path), 'changed'), path).toBe(true);
      expect(canDiscardFile(row(path), 'changed'), path).toBe(true);
    }
    expect(canUnstageFile(row('lnk'), 'staged')).toBe(true);

    // ` T` 文件 → 链接:stage 记下链接,unstage 回到 ` T`,discard 还原成原来的普通文件
    expect(await stageFile(app, repo, 'f.txt')).toEqual({ ok: true });
    expect(lsFiles('f.txt')).toMatch(/^120000 /);
    expect(git(repo, 'show', ':f.txt')).toBe('base');
    _resetRestoreCache();
    expect(await unstageFile(app, repo, 'f.txt')).toEqual({ ok: true });
    expect(git(repo, 'status', '--porcelain', '--', 'f.txt')).toBe(' T f.txt\n');
    expect(await discardFile(app, repo, 'f.txt')).toEqual({ ok: true });
    expect(lstatSync(join(repo, 'f.txt')).isFile()).toBe(true);
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('one\n');
    // ` T` 链接 → 文件:discard 还原成链接
    expect(await discardFile(app, repo, 'l2')).toEqual({ ok: true });
    expect(readlinkSync(join(repo, 'l2'))).toBe('base');
    // `T `:unstage 之后 index 回到链接,工作树的文件不动
    expect(await unstageFile(app, repo, 'lnk')).toEqual({ ok: true });
    expect(git(repo, 'status', '--porcelain', '--', 'lnk')).toBe(' T lnk\n');
    expect(readFileSync(join(repo, 'lnk'), 'utf8')).toBe('staged file\n');
    // AT / MT:discard 把工作树还原成 index 里的版本;暂存的内容始终没动
    expect(await discardFile(app, repo, 'at')).toEqual({ ok: true });
    expect(readFileSync(join(repo, 'at'), 'utf8')).toBe('content\n');
    expect(await discardFile(app, repo, 'mt')).toEqual({ ok: true });
    expect(readFileSync(join(repo, 'mt'), 'utf8')).toBe('two2\n');
    expect(git(repo, 'show', ':at')).toBe('content\n');
    expect(lsFiles('at')).toMatch(/^100644 /);
    expect(await scan()).toEqual(['A  at', ' M ch.sh', ' T lnk', 'M  mt']);

    // chmod + 内容修改:hunk 操作只动内容,mode 变更留给文件级操作
    const ch = await rendered(app, row('ch.sh'), 'changed');
    expect(ch.buttons).toEqual(['Stage', 'Discard']);
    if (!ch.diff.ok) throw new Error('ch.sh diff failed');
    expect(ch.diff.unifiedDiff).toContain('old mode 100644\nnew mode 100755\n');
    const patch = extractHunkPatchFromUnifiedDiff('ch.sh', ch.diff.unifiedDiff, hunkIndexes(ch.diff.unifiedDiff)[0]!);
    expect(await stageHunk(app, repo, patch!)).toEqual({ ok: true });
    expect(git(repo, 'show', ':ch.sh')).toBe('x\ny\n');
    expect(lsFiles('ch.sh')).toMatch(/^100644 /);
    expect(await unstageHunk(app, repo, patch!)).toEqual({ ok: true });
    expect(git(repo, 'show', ':ch.sh')).toBe('x\n');
    expect(await discardHunk(app, repo, patch!)).toEqual({ ok: true });
    expect(readFileSync(join(repo, 'ch.sh'), 'utf8')).toBe('x\n');
    expect(statSync(join(repo, 'ch.sh')).mode & 0o111).not.toBe(0);
  });
});

describe('the panel shows what a commit would take, without a manual Refresh (real git)', () => {
  it('R73 a staged file edited and staged again (status still `M `), and an unstaged file edited again (still ` M`): after the next auto-refresh tick the selected row and the rows looked at earlier all show the new content, and the commit holds exactly what the Staged rows showed', async () => {
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
    writeFileSync(join(repo, 'w.txt'), 'w0\n');
    writeFileSync(join(repo, 'w2.txt'), 'w2-0\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'w');
    writeFileSync(join(repo, 'f.txt'), 'f staged v1\n');
    writeFileSync(join(repo, 'g.txt'), 'g staged v1\n');
    git(repo, 'add', 'f.txt', 'g.txt');
    writeFileSync(join(repo, 'w.txt'), 'w edit v1\n');
    writeFileSync(join(repo, 'w2.txt'), 'w2 edit v1\n');
    const STATUS = 'M  f.txt\nM  g.txt\n M w.txt\n M w2.txt\n';
    expect(git(repo, 'status', '--porcelain')).toBe(STATUS);

    const app = realApp();
    installRepoSafetyGuard(app);
    const store = createGitStore({
      load: async () => ({ repoRoot: repo, changes: await scanStatus(app, repo) }),
      fetchDiff: (root, change, mode) => fetchDiff(app, root, change, mode),
    });
    const shownDiff = () => {
      const { selected, diffCache } = store.getState();
      return selected ? diffCache.get(`${selected.mode}:${selected.path}`) : undefined;
    };
    // refresh 之后选中项的 diff 是异步重读的:等它到位
    const settle = () => vi.waitFor(() => expect(shownDiff()).toBeDefined(), { timeout: 4000, interval: 10 });
    const shown = () => {
      const diff = shownDiff();
      return diff?.ok ? diff.modified : undefined;
    };
    const click = async (path: string, mode: 'staged' | 'changed') => {
      store.getState().selectFile(path, mode);
      await store.getState().loadDiff(path, mode);
      return shown();
    };
    // 面板的自动刷新 tick(GitViewerPanel onTick 的比较):status 指纹变了,或选中的工作树 diff 过期 → refresh
    let lastHash = '';
    const tick = async () => {
      const next = await readStatusHash(app, repo);
      const { selected } = store.getState();
      const stale = next !== lastHash || (selected?.mode === 'changed' && (await isWorktreeDiffStale(app, repo, shownDiff())));
      lastHash = next;
      if (stale) {
        await store.getState().refresh();
        await settle();
      }
      return stale;
    };

    await store.getState().refresh();
    await settle();
    lastHash = await readStatusHash(app, repo);
    expect(await click('g.txt', 'staged')).toBe('g staged v1\n');
    expect(await click('w2.txt', 'changed')).toBe('w2 edit v1\n');
    expect(await click('f.txt', 'staged')).toBe('f staged v1\n');
    expect(await tick()).toBe(false);

    // 终端里:两个已暂存的文件各自再改一次并 add;status 的字母没有变
    writeFileSync(join(repo, 'f.txt'), 'f staged v2 !\n');
    writeFileSync(join(repo, 'g.txt'), 'g staged v2 !\n');
    git(repo, 'add', 'f.txt', 'g.txt');
    expect(git(repo, 'status', '--porcelain')).toBe(STATUS);
    expect(await tick()).toBe(true);
    // 选中的 f:不点击就已是新内容;之前看过的 g:点回去也是新内容
    expect(shown()).toBe('f staged v2 !\n');
    expect(await click('g.txt', 'staged')).toBe('g staged v2 !\n');
    expect(await tick()).toBe(false);

    // 未暂存的文件再编辑一次(仍是 ` M`):选中的那个由 tick 发现
    expect(await click('w.txt', 'changed')).toBe('w edit v1\n');
    expect(await tick()).toBe(false);
    writeFileSync(join(repo, 'w.txt'), 'w edit v2 !!\n');
    writeFileSync(join(repo, 'w2.txt'), 'w2 edit v2 !!\n');
    expect(git(repo, 'status', '--porcelain')).toBe(STATUS);
    expect(await tick()).toBe(true);
    expect(shown()).toBe('w edit v2 !!\n');
    expect(shownDiff()).toMatchObject({ unifiedDiff: git(repo, 'diff', '--', 'w.txt') });
    // 没选中的 w2(之前看过 v1):点回去时重新读取
    expect(await click('w2.txt', 'changed')).toBe('w2 edit v2 !!\n');
    // 两次 tick 之间编辑并立刻点击:显示的不早于点击
    writeFileSync(join(repo, 'w.txt'), 'w edit v3 !!!\n');
    expect(await click('w.txt', 'changed')).toBe('w edit v3 !!!\n');
    expect(await tick()).toBe(false);

    // 提交的正是 Staged 行显示的内容
    const stagedShown = { f: await click('f.txt', 'staged'), g: await click('g.txt', 'staged') };
    expect(await gitCommit(app, repo, 'c')).toMatchObject({ ok: true });
    expect({ f: git(repo, 'show', 'HEAD:f.txt'), g: git(repo, 'show', 'HEAD:g.txt') }).toEqual(stagedShown);
  });
});

describe('a submodule entry has no hunks and no file content to discard (real git)', () => {
  const nested = (name: string) => {
    const dir = join(repo, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'inner.txt'), 'inner 1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'inner 1');
    return dir;
  };
  const advance = (dir: string) => {
    appendFileSync(join(dir, 'inner.txt'), 'inner 2\n');
    git(dir, 'commit', '-qam', 'inner 2');
    return git(dir, 'rev-parse', 'HEAD').trim();
  };

  it('R74 ` M sub` and `AM sub2`: the gitlink change is shown without hunk buttons and yields no hunk patch (applying one by hand "succeeds" and changes nothing); Stage / Unstage work on the entry; Discard says it is a submodule instead of reporting success', async () => {
    const sub = nested('sub');
    git(repo, 'add', 'sub');
    git(repo, 'commit', '-qm', 'add sub');
    const subHead = advance(sub);
    const sub2 = nested('sub2');
    git(repo, 'add', 'sub2');
    advance(sub2);
    expect(git(repo, 'status', '--porcelain')).toBe(' M sub\nAM sub2\n');

    const app = realApp();
    installRepoSafetyGuard(app);
    const changes = await scanStatus(app, repo);
    const row = (path: string) => changes.find((c) => c.path === path)!;

    for (const path of ['sub', 'sub2']) {
      const view = await rendered(app, row(path), 'changed');
      if (!view.diff.ok) throw new Error(`${path}: diff failed`);
      expect(view.diff.unifiedDiff, path).toMatch(/^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/m);
      expect(view.added.join(), path).toContain('+Subproject commit ');
      expect(view.buttons, path).toEqual([]);
      const at = view.diff.unifiedDiff.split('\n').findIndex((l) => l.startsWith('@@'));
      expect(extractHunkPatchFromUnifiedDiff(path, view.diff.unifiedDiff, at), path).toBeNull();

      // 为什么不能有 Discard hunk:照旧的方式拼出的补丁,git 说应用成功,而条目原样还在
      const lines = view.diff.unifiedDiff.split('\n');
      const byHand = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...lines.slice(at).filter((l) => l !== '')].join('\n') + '\n';
      const before = git(repo, 'status', '--porcelain');
      expect(await discardHunk(app, repo, byHand), path).toEqual({ ok: true });
      expect(git(repo, 'status', '--porcelain'), path).toBe(before);
    }

    // 文件级 Discard:如实说明,不运行 checkout(它同样以 0 退出而什么都不做)
    for (const path of ['sub', 'sub2']) {
      expect(canDiscardFile(row(path), 'changed'), path).toBe(true);
      expect(await discardFile(app, repo, path), path).toEqual({ ok: false, error: SUBMODULE_DISCARD_ERROR });
    }
    expect(git(repo, 'status', '--porcelain')).toBe(' M sub\nAM sub2\n');
    // 普通文件不受影响
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    expect(await discardFile(app, repo, 'f.txt')).toEqual({ ok: true });
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('one\n');

    // 文件级 Stage / Unstage 作用于这个条目
    expect(canStageFile(row('sub'), 'changed')).toBe(true);
    expect(await stageFile(app, repo, 'sub')).toEqual({ ok: true });
    expect(git(repo, 'status', '--porcelain', '--', 'sub')).toBe('M  sub\n');
    expect(git(repo, 'ls-files', '-s', '--', 'sub')).toBe(`160000 ${subHead} 0\tsub\n`);
    _resetRestoreCache();
    expect(await unstageFile(app, repo, 'sub')).toEqual({ ok: true });
    expect(git(repo, 'status', '--porcelain', '--', 'sub')).toBe(' M sub\n');
  });
});

// 宿主把命令输出按 UTF-8 解码(非法字节 → U+FFFD),补丁再按 UTF-8 写回:经过这条路的非 UTF-8 内容回不去
describe('bytes that are not valid UTF-8 never make a round trip through a hunk patch (real git)', () => {
  const LATIN1_E = Buffer.from([0xe9]); // "é" in Latin-1 / the lead byte of a GBK character
  const bytes = (...parts: Array<string | Buffer>) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : p)));
  const hex = (b: Buffer) => b.toString('hex');
  const indexBlob = (path: string) => execFileSync('git', ['cat-file', 'blob', `:0:${path}`], { cwd: repo, env: ENV });
  // 旧的做法:不看内容,直接从 diff 文本拼补丁
  const byHand = (path: string, unifiedDiff: string) => {
    const lines = unifiedDiff.split('\n');
    const at = lines.findIndex((l) => l.startsWith('@@'));
    return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...lines.slice(at).filter((l, i, all) => !(i === all.length - 1 && l === ''))].join('\n') + '\n';
  };

  it('R75 a Latin-1 line in a text file: git calls the file text and the hunk applies cleanly — with the byte replaced by U+FFFD. The panel offers no hunk action for such a diff (Changes and Staged), says why, and file-level Stage / Unstage / Discard keep the bytes exactly', async () => {
    const before = bytes('one\n', 'two\n', 'three\n');
    const after = bytes('one\n', 'two\n', 'three\n', 'caf', LATIN1_E, ' added\n');
    writeFileSync(join(repo, 'l.txt'), before);
    // HEAD 里就有 Latin-1 行的文件:删掉那一行(Discard hunk 会把它"还原"回来)
    writeFileSync(join(repo, 'd.txt'), bytes('keep\n', 'na', LATIN1_E, 've\n'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'latin1');
    writeFileSync(join(repo, 'l.txt'), after);
    writeFileSync(join(repo, 'd.txt'), bytes('keep\n'));
    expect(git(repo, 'status', '--porcelain')).toBe(' M d.txt\n M l.txt\n');

    const app = realApp();
    installRepoSafetyGuard(app);
    const row = async (path: string) => (await scanStatus(app, repo)).find((c) => c.path === path)!;
    expect((await row('l.txt')).kind).toBe('text');

    // 面板:没有 hunk 按钮,拼不出补丁,并说明原因
    for (const path of ['l.txt', 'd.txt']) {
      const view = await rendered(app, await row(path), 'changed');
      if (!view.diff.ok) throw new Error(`${path}: diff failed`);
      expect(view.diff.unifiedDiff, path).toContain('�');
      expect(view.buttons, path).toEqual([]);
      const at = view.diff.unifiedDiff.split('\n').findIndex((l) => l.startsWith('@@'));
      expect(extractHunkPatchFromUnifiedDiff(path, view.diff.unifiedDiff, at), path).toBeNull();
      expect(view.html, path).toContain(NON_UTF8_HUNK_NOTE);
    }
    // 普通文件不受影响
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    const plain = await rendered(app, await row('f.txt'), 'changed');
    expect(plain.buttons).toEqual(['Stage', 'Discard']);
    expect(plain.html).not.toContain(NON_UTF8_HUNK_NOTE);
    git(repo, 'checkout', '--', 'f.txt');

    // 为什么:照旧拼出的补丁,git 说应用成功,而写进去的是 U+FFFD(EF BF BD),不是原来的字节
    const lDiff = (await rendered(app, await row('l.txt'), 'changed')).diff;
    const dDiff = (await rendered(app, await row('d.txt'), 'changed')).diff;
    if (!lDiff.ok || !dDiff.ok) throw new Error('diff failed');
    expect(await stageHunk(app, repo, byHand('l.txt', lDiff.unifiedDiff))).toEqual({ ok: true });
    expect(hex(indexBlob('l.txt'))).toBe(hex(bytes(before, 'caf� added\n')));
    expect(hex(indexBlob('l.txt'))).not.toBe(hex(after));
    git(repo, 'reset', '-q', '--', 'l.txt');
    expect(await discardHunk(app, repo, byHand('d.txt', dDiff.unifiedDiff))).toEqual({ ok: true });
    expect(hex(readFileSync(join(repo, 'd.txt')))).toBe(hex(bytes('keep\n', 'na�ve\n')));
    writeFileSync(join(repo, 'd.txt'), bytes('keep\n'));

    // 文件级操作:字节精确
    expect(await stageFile(app, repo, 'l.txt')).toEqual({ ok: true });
    expect(hex(indexBlob('l.txt'))).toBe(hex(after));
    // Staged 区同样没有 Unstage hunk
    const staged = await rendered(app, await row('l.txt'), 'staged');
    expect(staged.buttons).toEqual([]);
    expect(staged.html).toContain(NON_UTF8_HUNK_NOTE);
    _resetRestoreCache();
    expect(await unstageFile(app, repo, 'l.txt')).toEqual({ ok: true });
    expect(hex(indexBlob('l.txt'))).toBe(hex(before));
    expect(hex(readFileSync(join(repo, 'l.txt')))).toBe(hex(after));
    expect(await discardFile(app, repo, 'd.txt')).toEqual({ ok: true });
    expect(hex(readFileSync(join(repo, 'd.txt')))).toBe(hex(bytes('keep\n', 'na', LATIN1_E, 've\n')));
  });

  it('R76 a file name that is not valid UTF-8 (possible in an index; on Linux also on disk) reaches the plugin as U+FFFD, and handing that back to git names a different path — possibly another real file. Such rows are shown but cannot be selected or operated on', async () => {
    const oid = git(repo, 'rev-parse', 'HEAD:f.txt').trim();
    const rawName = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9])]);
    // index 里两个条目:名字是 Latin-1 字节的 `caf\xE9`,以及名字确实含 U+FFFD 字符的文件
    // 名字经 stdin 逐字节传入(argv 在 Node 里只能是字符串)
    execFileSync('git', ['update-index', '--index-info'], { cwd: repo, env: ENV, input: Buffer.concat([Buffer.from(`100644 ${oid}\t`), rawName, Buffer.from('\n')]) });
    writeFileSync(join(repo, 'caf�'), 'the other file\n');
    git(repo, 'add', '--', 'caf�');

    const app = realApp();
    installRepoSafetyGuard(app);
    const rows = (await scanStatus(app, repo)).filter((c) => c.path === 'caf�');
    // 两条记录解码后的路径相同:无法区分
    expect(rows.map((c) => `${c.statusX}${c.statusY}`).sort()).toEqual(['A ', 'AD']);
    expect(rows.every((c) => c.inoperable === true)).toBe(true);
    for (const change of rows) {
      for (const section of ['staged', 'changed'] as const) {
        expect(canUnstageFile(change, section)).toBe(false);
        expect(canStageFile(change, section)).toBe(false);
        expect(canDiscardFile(change, section)).toBe(false);
      }
    }
    // 操作入口同样拒绝(不起进程):否则作用在那个名字确实是 U+FFFD 的文件上
    const before = git(repo, 'status', '--porcelain=v2');
    _resetRestoreCache();
    expect((await unstageFile(app, repo, 'caf�')).ok).toBe(false);
    expect((await stageFile(app, repo, 'caf�')).ok).toBe(false);
    expect((await discardFile(app, repo, 'caf�')).ok).toBe(false);
    expect((await fetchDiff(app, repo, rows[0]!, 'staged')).ok).toBe(false);
    expect(git(repo, 'status', '--porcelain=v2')).toBe(before);
    expect(readFileSync(join(repo, 'caf�'), 'utf8')).toBe('the other file\n');
  });
});

// 文件级操作的参数是路径,而 git 把路径当"前缀"用:磁盘上 / index 里这个位置现在是目录时,操作会波及用户没点的内容
describe('a file-level action acts on the entry that was clicked, not on a directory that now sits at its path (real git)', () => {
  const exists = (...parts: string[]) => existsSync(join(repo, ...parts));
  // `x` 是被跟踪的文件;工作树里它被换成了一个目录,里面有 git 不跟踪的文件。status 只给出 ` D x`:
  // x 还是 index 里的条目时,git 不列出这个目录里的未跟踪文件——面板里看不到 work.txt。
  const fileBecomesDir = () => {
    writeFileSync(join(repo, 'x'), 'tracked file\n');
    git(repo, 'add', 'x');
    git(repo, 'commit', '-qm', 'x');
    rmSync(join(repo, 'x'));
    mkdirSync(join(repo, 'x'));
    writeFileSync(join(repo, 'x', 'work.txt'), 'unsaved work\n');
  };
  // `x` 被换成了一个嵌套仓库(状态 ` T x`),里面有未跟踪的文件
  const fileBecomesRepo = () => {
    writeFileSync(join(repo, 'x'), 'tracked file\n');
    git(repo, 'add', 'x');
    git(repo, 'commit', '-qm', 'x');
    rmSync(join(repo, 'x'));
    mkdirSync(join(repo, 'x'));
    git(join(repo, 'x'), 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'x', 'inner.txt'), 'inner\n');
    git(join(repo, 'x'), 'add', '.');
    git(join(repo, 'x'), 'commit', '-qm', 'inner');
    writeFileSync(join(repo, 'x', 'work.txt'), 'unsaved work\n');
  };
  // `a/b` 是被跟踪的文件;目录 `a` 被换成了一个未跟踪的文件
  const parentBecomesFile = () => {
    mkdirSync(join(repo, 'a'));
    writeFileSync(join(repo, 'a', 'b'), 'tracked file\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'a/b');
    rmSync(join(repo, 'a'), { recursive: true });
    writeFileSync(join(repo, 'a'), 'unsaved work\n');
  };
  const rowOf = async (app: CoPluginApp, path: string) => (await scanStatus(app, repo)).find((c) => c.path === path)!;

  it('R77 Discard: a directory (plain, or a nested repository) at the path, or a file where a parent folder was — `git checkout --` deletes them with everything inside, tracked or not. discardFile refuses and nothing is touched; an ordinary deleted / modified file is still restored', async () => {
    const app = realApp();
    installRepoSafetyGuard(app);

    // 为什么:git 自己的行为
    fileBecomesDir();
    expect(git(repo, 'status', '--porcelain')).toBe(' D x\n');
    expect((await gitExec(app, repo, ['checkout', '--', 'x'])).exitCode).toBe(0);
    expect(readFileSync(join(repo, 'x'), 'utf8')).toBe('tracked file\n'); // 目录和 work.txt 没了

    rmSync(join(repo, 'x'));
    mkdirSync(join(repo, 'x'));
    writeFileSync(join(repo, 'x', 'work.txt'), 'unsaved work\n');
    expect(canDiscardFile(await rowOf(app, 'x'), 'changed')).toBe(true);
    expect(await discardFile(app, repo, 'x')).toEqual({ ok: false, error: DIRECTORY_DISCARD_ERROR });
    expect(readFileSync(join(repo, 'x', 'work.txt'), 'utf8')).toBe('unsaved work\n');
    expect(git(repo, 'status', '--porcelain')).toBe(' D x\n');
    rmSync(join(repo, 'x'), { recursive: true });
    git(repo, 'rm', '-q', '--cached', 'x');
    git(repo, 'commit', '-qm', 'drop x');

    fileBecomesRepo();
    expect(git(repo, 'status', '--porcelain')).toBe(' T x\n');
    expect(canDiscardFile(await rowOf(app, 'x'), 'changed')).toBe(true);
    expect(await discardFile(app, repo, 'x')).toEqual({ ok: false, error: DIRECTORY_DISCARD_ERROR });
    expect(exists('x', '.git')).toBe(true);
    expect(readFileSync(join(repo, 'x', 'work.txt'), 'utf8')).toBe('unsaved work\n');
    expect(git(repo, 'status', '--porcelain')).toBe(' T x\n');

    parentBecomesFile();
    expect(git(repo, 'status', '--porcelain', '--', 'a')).toBe(' D a/b\n?? a\n');
    expect(await discardFile(app, repo, 'a/b')).toEqual({ ok: false, error: parentNotDirectoryDiscardError('a') });
    expect(readFileSync(join(repo, 'a'), 'utf8')).toBe('unsaved work\n');

    // 普通情形不受影响:删掉的文件、改过的文件
    rmSync(join(repo, 'g.txt'));
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    expect(await discardFile(app, repo, 'g.txt')).toEqual({ ok: true });
    expect(await discardFile(app, repo, 'f.txt')).toEqual({ ok: true });
    expect(readFileSync(join(repo, 'g.txt'), 'utf8')).toBe('gee\n');
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('one\n');
  });

  it('R77b Discard is fail-closed: when the path cannot be looked at (no file access, or lstat fails with anything but "not found") nothing is checked out', async () => {
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    const app = realApp();
    installRepoSafetyGuard(app);
    const noFs = { shell: app.shell } as unknown as CoPluginApp;
    expect(await discardFile(noFs, repo, 'f.txt')).toEqual({ ok: false, error: UNVERIFIED_PATH_ERROR });
    const denied = { shell: app.shell, fs: { lstat: async () => { throw new Error('ScopeError: path is outside granted scopes'); } } } as unknown as CoPluginApp;
    expect(await discardFile(denied, repo, 'f.txt')).toEqual({ ok: false, error: UNVERIFIED_PATH_ERROR });
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  it('R78 Stage: on a ` D x` row `git add -- x` would add every untracked file inside the directory that replaced x — content the row never showed. stageFile refuses; a nested repository (` T x`) is staged as the one entry it is, and a deletion below a path that became a file is staged as that deletion', async () => {
    const app = realApp();
    installRepoSafetyGuard(app);

    fileBecomesDir();
    const row = await rowOf(app, 'x');
    expect(`${row.statusX}${row.statusY}`).toBe(' D');
    expect(canStageFile(row, 'changed')).toBe(true);
    // 为什么:git 自己的行为
    git(repo, 'add', '--', 'x');
    expect(git(repo, 'status', '--porcelain')).toBe('D  x\nA  x/work.txt\n');
    git(repo, 'reset', '-q');

    expect(await stageFile(app, repo, 'x')).toEqual({ ok: false, error: DIRECTORY_STAGE_ERROR });
    expect(git(repo, 'status', '--porcelain')).toBe(' D x\n');
    // (status 在 x 仍是 index 条目时不列出目录里的未跟踪文件:用户在面板里根本看不到 work.txt)
    rmSync(join(repo, 'x'), { recursive: true });
    git(repo, 'rm', '-q', '--cached', 'x');
    git(repo, 'commit', '-qm', 'drop x');

    fileBecomesRepo();
    expect(await stageFile(app, repo, 'x')).toEqual({ ok: true });
    // (不带 --ignore-submodules=dirty 时,嵌套仓库里未跟踪的 work.txt 让它显示成 `TM`)
    expect(git(repo, 'status', '--porcelain', '--ignore-submodules=dirty')).toBe('T  x\n');
    expect(git(repo, 'ls-files', '-s', '--', 'x')).toMatch(/^160000 [0-9a-f]+ 0\tx\n$/);
    expect(readFileSync(join(repo, 'x', 'work.txt'), 'utf8')).toBe('unsaved work\n');

    parentBecomesFile();
    expect(await stageFile(app, repo, 'a/b')).toEqual({ ok: true });
    expect(git(repo, 'status', '--porcelain', '--', 'a')).toBe('D  a/b\n?? a\n');
  });

  it('R79 Unstage: with `D  x` and `AM x/work.txt` staged, `git restore --staged -- x` (and `git reset HEAD -- x`) also unstages x/work.txt and drops its staged content. unstageFile refuses on the x row; the x/work.txt row and ordinary rows unstage as before', async () => {
    const app = realApp();
    installRepoSafetyGuard(app);
    const stageBoth = () => {
      git(repo, 'add', '-A');
      appendFileSync(join(repo, 'x', 'work.txt'), 'later edit\n');
    };
    fileBecomesDir();
    stageBoth();
    appendFileSync(join(repo, 'f.txt'), 'two\n');
    git(repo, 'add', 'f.txt');
    const STATUS = 'M  f.txt\nD  x\nAM x/work.txt\n';
    expect(git(repo, 'status', '--porcelain')).toBe(STATUS);
    expect(canUnstageFile(await rowOf(app, 'x'), 'staged')).toBe(true);

    // 为什么:git 自己的行为(两种写法都一样)
    for (const args of [['restore', '--staged', '--', 'x'], ['reset', '-q', 'HEAD', '--', 'x']]) {
      expect((await gitExec(app, repo, args)).exitCode).toBe(0);
      expect(git(repo, 'status', '--porcelain')).toBe('M  f.txt\n D x\n');
      git(repo, 'add', '-A');
      expect(git(repo, 'status', '--porcelain')).toBe('M  f.txt\nD  x\nA  x/work.txt\n');
    }
    git(repo, 'reset', '-q', '--', 'x');
    writeFileSync(join(repo, 'x', 'work.txt'), 'unsaved work\n');
    stageBoth();
    expect(git(repo, 'status', '--porcelain')).toBe(STATUS);

    _resetRestoreCache();
    expect(await unstageFile(app, repo, 'x')).toEqual({ ok: false, error: DIRECTORY_UNSTAGE_ERROR });
    expect(git(repo, 'status', '--porcelain')).toBe(STATUS);
    expect(git(repo, 'show', ':0:x/work.txt')).toBe('unsaved work\n');

    expect(await unstageFile(app, repo, 'f.txt')).toEqual({ ok: true });
    expect(await unstageFile(app, repo, 'x/work.txt')).toEqual({ ok: true });
    expect(git(repo, 'status', '--porcelain')).toBe(' M f.txt\nD  x\n?? x/\n');
    // 子条目不在了:x 这一行可以撤销暂存
    expect(await unstageFile(app, repo, 'x')).toEqual({ ok: true });
    expect(git(repo, 'status', '--porcelain')).toBe(' M f.txt\n D x\n');
  });
});

describe('the status fingerprint follows HEAD, not only the entries (real git)', () => {
  it('R80 a staged new file, then HEAD is replaced / moved while the entries stay byte-identical (reword with `commit --amend --only`, a commit made with plumbing, switching to a new branch): each changes the fingerprint; reading it twice in a row does not; the list scan is a separate command and is not affected by the header lines', async () => {
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
    writeFileSync(join(repo, 'n.txt'), 'new\n');
    git(repo, 'add', 'n.txt');
    const app = realApp();
    installRepoSafetyGuard(app);
    const entries = () => git(repo, 'status', '--porcelain=v2');
    const snapshot = async () => ({ fingerprint: await readStatusHash(app, repo), entries: entries() });

    const start = await snapshot();
    expect(await readStatusHash(app, repo)).toBe(start.fingerprint);
    expect(start.fingerprint).toContain(`# branch.oid ${git(repo, 'rev-parse', 'HEAD').trim()}`);
    expect(start.fingerprint).toContain('# branch.head main');

    git(repo, 'commit', '-q', '--amend', '--only', '-m', 'reworded');
    const reworded = await snapshot();
    expect(reworded.entries).toBe(start.entries);
    expect(reworded.fingerprint).not.toBe(start.fingerprint);

    const made = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'made elsewhere').trim();
    git(repo, 'update-ref', 'HEAD', made);
    const moved = await snapshot();
    expect(moved.entries).toBe(start.entries);
    expect(moved.fingerprint).not.toBe(reworded.fingerprint);

    git(repo, 'checkout', '-q', '-b', 'other');
    const switched = await snapshot();
    expect(switched.entries).toBe(start.entries);
    expect(switched.fingerprint).not.toBe(moved.fingerprint);

    expect((await scanStatus(app, repo)).map((c) => `${c.statusX}${c.statusY} ${c.path}`)).toEqual(['A  n.txt']);
  });

  it('R80b an unborn branch and a detached HEAD have a fingerprint too (the command does not fail)', async () => {
    const app = realApp();
    installRepoSafetyGuard(app);
    git(repo, 'checkout', '-q', '--detach');
    expect(await readStatusHash(app, repo)).toContain('# branch.head (detached)');
    git(repo, 'checkout', '-q', '--orphan', 'fresh');
    expect(await readStatusHash(app, repo)).toContain('# branch.oid (initial)');
  });
});

describe('submodule pointers in the fingerprint (real git)', () => {
  it('R81 what a commit takes is covered: a staged submodule pointer that moves again and is staged again (`M  sub` both times) changes the fingerprint, and the Staged row read after that shows the new commit', async () => {
    const sub = join(repo, 'sub');
    mkdirSync(sub);
    git(sub, 'init', '-q', '-b', 'main');
    const advance = (n: number) => {
      writeFileSync(join(sub, 'inner.txt'), `inner ${n}\n`);
      git(sub, 'add', '.');
      git(sub, 'commit', '-qm', `inner ${n}`);
      return git(sub, 'rev-parse', 'HEAD').trim();
    };
    advance(1);
    git(repo, 'add', 'sub');
    git(repo, 'commit', '-qm', 'add sub');
    advance(2);
    git(repo, 'add', 'sub');
    expect(git(repo, 'status', '--porcelain')).toBe('M  sub\n');

    const app = realApp();
    installRepoSafetyGuard(app);
    const first = await readStatusHash(app, repo);
    const third = advance(3);
    git(repo, 'add', 'sub');
    expect(git(repo, 'status', '--porcelain')).toBe('M  sub\n');
    expect(await readStatusHash(app, repo)).not.toBe(first);

    const row = (await scanStatus(app, repo)).find((c) => c.path === 'sub')!;
    const diff = await fetchDiff(app, repo, row, 'staged');
    expect(diff.ok && diff.unifiedDiff).toContain(`+Subproject commit ${third}`);
  });
});
