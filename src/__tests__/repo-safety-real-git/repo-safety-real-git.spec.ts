// 真实 git 集成:构造含恶意 .git/config 的临时仓库,每个可执行配置指向一个"写标记文件"的脚本,
// 断言插件的 git 调用不再触发任何标记;同时验证普通仓库功能与用户 hooks 不受影响。
import { spawn, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, readFileSync, renameSync, mkdtempSync, readdirSync, rmSync, writeFileSync, appendFileSync, statSync, lstatSync, mkdirSync, realpathSync, symlinkSync, utimesSync } from 'node:fs';
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
import { installRepoSafetyGuard, probeRepoSafety } from '../../git/repo-safety';
import { detectRepo } from '../../git/repo-detect';
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

  it('R30 keys evaluated as non-redirecting stay trusted and leak nothing: core.excludesFile / core.attributesFile / mailmap.file / diff.orderFile / commit.template pointing at an outside file', async () => {
    const outside = join(secretDir, 'f.txt');
    for (const key of ['core.excludesFile', 'core.attributesFile', 'mailmap.file', 'diff.orderFile', 'commit.template']) {
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
      expect((await discardFile(app, repo, 'sub')).ok).toBe(true);
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

    // 证明 fixture:去掉子模块相关加固后,同一组操作会在 sub/ 里起 git(`run_command: cd sub; ...`;其 filter 被执行见 R34)
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

    git(repo, '--no-optional-locks', '-c', 'diff.ignoreSubmodules=dirty', 'status', '--porcelain');
    expect(marks()).toContain('sub-clean');
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
