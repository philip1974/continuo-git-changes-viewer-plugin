// 真实 git 集成:构造含恶意 .git/config 的临时仓库,每个可执行配置指向一个"写标记文件"的脚本,
// 断言插件的 git 调用不再触发任何标记;同时验证普通仓库功能与用户 hooks 不受影响。
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, appendFileSync, statSync, lstatSync, mkdirSync, realpathSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchDiff } from '../../git/diff-fetcher';
import { discardFile } from '../../git/discard-file';
import { discardHunk } from '../../git/discard-hunk';
import { DISABLED_HOOKS_PATH, gitExec } from '../../git/exec';
import { detectRepoHooks } from '../../git/repo-hooks';
import { stageHunk } from '../../git/stage-hunk';
import { _resetRestoreCache, unstageFile } from '../../git/unstage-file';
import { unstageHunk } from '../../git/unstage-hunk';
import { gitCommit } from '../../git/git-commit';
import { hasHeadCommit, readHeadMessage } from '../../git/head-meta';
import { installRepoSafetyGuard } from '../../git/repo-safety';
import { readStatusHash } from '../../git/status-hash';
import { stageFile } from '../../git/stage-file';
import { scanStatus } from '../../git/status-scanner';
import type { CoPluginApp, PluginShellExecOptions, PluginShellExecResult } from '../../sdk/types';

// 最小 app.shell / app.fs 实现(对应宿主 shell.exec:env 合并进进程 env)
function realApp(): CoPluginApp {
  const exec = (cmd: string, args: readonly string[], opts: PluginShellExecOptions = {}) =>
    new Promise<PluginShellExecResult>((resolve) => {
      const child = spawn(cmd, [...args], {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code, signal) =>
        resolve({ stdout, stderr, exitCode: code, signal, timedOut: false, truncated: false }),
      );
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
});

// stat-dirty 但内容相同 → status 必须重新哈希(触发 clean filter);g.txt 有真实改动 → diff 会走 textconv/ext
function dirty(dir = repo, file = 'f.txt'): void {
  utimesSync(join(dir, file), new Date(1_000_000_000_000), new Date(1_000_000_000_000));
}

async function runEverything(app: CoPluginApp): Promise<void> {
  dirty();
  appendFileSync(join(repo, 'g.txt'), 'more\n');
  const changes = await scanStatus(app, repo);
  await readStatusHash(app, repo).catch(() => '');
  await fetchDiff(app, repo, changes[0] ?? { path: 'f.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' });
  await readHeadMessage(app, repo);
  await hasHeadCommit(app, repo);
}

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
});
