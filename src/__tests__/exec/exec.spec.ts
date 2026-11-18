import { describe, expect, it, vi } from 'vitest';
import { buildGitArgs, buildGitEnv, gitExec, registerGitGuard, stripTrailingNewline } from '../../git/exec';
import type { CoPluginApp } from '../../sdk/types';

function makeApp() {
  const exec = vi.fn().mockResolvedValue({
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
  });
  return {
    app: {
      shell: { exec },
    } as unknown as CoPluginApp,
    exec,
  };
}

const GLOBALS = [
  '--no-optional-locks',
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'submodule.recurse=false',
  '-c',
  'diff.submodule=short',
  '-c',
  'status.submoduleSummary=false',
  '-c',
  'maintenance.auto=false',
  '-c',
  'gc.auto=0',
];
const NO_NETWORK = [
  '-c', 'protocol.allow=never',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'status.renames=true',
  '-c', 'diff.renames=true',
];
const ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: ':',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_GLOB_PATHSPECS: '0',
  GIT_NOGLOB_PATHSPECS: '0',
  GIT_ICASE_PATHSPECS: '0',
};
const COMMIT_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: ':',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
};

describe('gitExec hardened shell wrapper', () => {
  it('T1 prepends hardening globals, status gets --ignore-submodules=dirty, env is hardened', async () => {
    const { app, exec } = makeApp();

    await gitExec(app, '/repo', ['status', '--porcelain=v1', '-z']);

    expect(exec).toHaveBeenCalledWith(
      'git',
      [...GLOBALS, ...NO_NETWORK, 'status', '--ignore-submodules=dirty', '--porcelain=v1', '-z'],
      { cwd: '/repo', env: ENV },
    );
  });

  it('T2 preserves caller env but forces hardening env values', async () => {
    const { app, exec } = makeApp();

    await gitExec(app, '/repo', ['diff'], {
      env: { LANG: 'C', GIT_OPTIONAL_LOCKS: '1', GIT_EDITOR: 'vim' },
    });

    expect(exec).toHaveBeenCalledWith(
      'git',
      [...GLOBALS, ...NO_NETWORK, 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--submodule=short'],
      { cwd: '/repo', env: { LANG: 'C', ...ENV } },
    );
  });

  it('T3 diff/show/log never run external diff, textconv or signature verification', () => {
    expect(buildGitArgs(['diff', '--cached', '--', 'a.ts'])).toEqual([
      ...GLOBALS, ...NO_NETWORK,
      'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--submodule=short', '--cached', '--', 'a.ts',
    ]);
    expect(buildGitArgs(['show', 'HEAD:a.ts'])).toEqual([
      ...GLOBALS, ...NO_NETWORK,
      'show', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--submodule=short', 'HEAD:a.ts',
    ]);
    expect(buildGitArgs(['log', '-1', '--pretty=%B'])).toEqual([
      ...GLOBALS, ...NO_NETWORK,
      'log', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--submodule=short', '-1', '--pretty=%B',
    ]);
  });

  it('T3b nothing may spawn git inside a nested repository: diff.submodule / submoduleSummary / auto-maintenance are pinned for every subcommand, commit included', () => {
    for (const sub of [['status'], ['diff'], ['show', 'HEAD'], ['log', '-1'], ['add', '--', 'a'], ['commit', '-F', '-'], ['checkout', '--', 'a']]) {
      const args = buildGitArgs(sub);
      const before = args.slice(0, args.indexOf(sub[0]!));
      for (const pin of ['diff.submodule=short', 'status.submoduleSummary=false', 'submodule.recurse=false', 'maintenance.auto=false', 'gc.auto=0']) {
        expect(before[before.indexOf(pin) - 1]).toBe('-c');
      }
    }
    for (const sub of ['diff', 'show', 'log']) {
      expect(buildGitArgs([sub])).toContain('--submodule=short');
    }
    // 必须是命令行参数:-c diff.ignoreSubmodules 会被 submodule.<name>.ignore 盖过
    expect(buildGitArgs(['status'])).toContain('--ignore-submodules=dirty');
    expect(buildGitArgs(['diff'])).toContain('--ignore-submodules=dirty');
  });

  it('T4 commit keeps repository hooks enabled but is cut off from the network unless the user confirmed running repository hooks', async () => {
    const { app, exec } = makeApp();

    await gitExec(app, '/repo', ['commit', '-F', '-'], { input: 'msg' });
    await gitExec(app, '/repo', ['commit', '--amend', '-F', '-'], { input: 'msg', repoHooksConfirmed: true });

    const [, args, opts] = exec.mock.calls[0]!;
    expect(args).toEqual([...GLOBALS, '-c', 'protocol.allow=never', 'commit', '--quiet', '-F', '-']);
    expect(args.some((a: string) => a.startsWith('core.hooksPath'))).toBe(false);
    expect(opts.env).toEqual(COMMIT_ENV);

    const [, confirmedArgs, confirmedOpts] = exec.mock.calls[1]!;
    expect(confirmedArgs).toEqual([...GLOBALS, 'commit', '--quiet', '--amend', '-F', '-']);
    expect(confirmedOpts.env).toEqual({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: ':' });
    expect(confirmedOpts).not.toHaveProperty('repoHooksConfirmed');
  });

  it('T4b repoHooksConfirmed never opens the network or enables hooks for any other subcommand', () => {
    for (const sub of [['status'], ['diff'], ['add', '--', 'a'], ['show', 'HEAD:a'], ['checkout', '--', 'a']]) {
      expect(buildGitArgs(sub, { repoHooksConfirmed: true })).toEqual(buildGitArgs(sub));
      expect(buildGitEnv(sub, {}, { repoHooksConfirmed: true })).toEqual(ENV);
    }
  });

  it('T8 every non-commit subcommand (index / worktree writers included) disables repository hooks', () => {
    for (const sub of [['add', '--', 'a'], ['apply', '--cached', '-'], ['restore', '--staged', '--', 'a'],
      ['reset', 'HEAD', '--', 'a'], ['checkout', '--', 'a'], ['status'], ['rev-parse', '--git-common-dir'], ['config', '--list']]) {
      const args = buildGitArgs(sub);
      const i = args.indexOf('core.hooksPath=/dev/null');
      expect(i).toBeGreaterThan(0);
      expect(args[i - 1]).toBe('-c');
      expect(i).toBeLessThan(args.indexOf(sub[0]!));
    }
  });

  it('T5 a registered guard refusal returns a failed result without spawning git', async () => {
    const { app, exec } = makeApp();
    const reg = registerGitGuard(app.shell, async () => 'restricted repo');

    const r = await gitExec(app, '/repo', ['status']);

    expect(exec).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(128);
    expect(r.stderr).toBe('restricted repo');
    reg.dispose();
    await gitExec(app, '/repo', ['status']);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('T6 a throwing guard fails closed', async () => {
    const { app, exec } = makeApp();
    registerGitGuard(app.shell, async () => {
      throw new Error('boom');
    });

    const r = await gitExec(app, '/repo', ['status']);

    expect(exec).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(128);
    expect(r.stderr).toContain('boom');
  });

  it('T7 a passing guard lets the hardened command run', async () => {
    const { app, exec } = makeApp();
    const guard = vi.fn(async () => null);
    registerGitGuard(app.shell, guard);

    await gitExec(app, '/repo', ['rev-parse', 'HEAD']);

    expect(guard).toHaveBeenCalledWith('/repo');
    expect(exec).toHaveBeenCalledWith('git', [...GLOBALS, ...NO_NETWORK, 'rev-parse', 'HEAD'], expect.anything());
  });

  it('T9 GIT_ALLOW_PROTOCOL is an empty list (beats repo protocol.<name>.allow) and the caller env cannot re-enable it; only a hooks-confirmed commit leaves it unset', () => {
    for (const sub of [['status'], ['show', 'HEAD:a'], ['diff'], ['add', '--', 'a'], ['rev-parse', 'HEAD']]) {
      expect(buildGitEnv(sub, { GIT_ALLOW_PROTOCOL: 'file:ssh:ext' })).toMatchObject({ GIT_ALLOW_PROTOCOL: '' });
    }
    expect(buildGitEnv(['commit', '-F', '-'], { GIT_ALLOW_PROTOCOL: 'ssh' })).toMatchObject({ GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' });
    const confirmed = buildGitEnv(['commit', '-F', '-'], {}, { repoHooksConfirmed: true });
    expect(confirmed).not.toHaveProperty('GIT_ALLOW_PROTOCOL');
    expect(confirmed).not.toHaveProperty('GIT_NO_LAZY_FETCH');
  });
});

describe('literal pathspecs', () => {
  it('T11 every path-taking call treats paths literally (GIT_LITERAL_PATHSPECS=1, caller env cannot turn it off); commit — whose env reaches hooks — does not set it', () => {
    for (const sub of [['add', '--', '*'], ['checkout', '--', ':(glob)**'], ['restore', '--staged', '--', '[id].tsx'],
      ['reset', 'HEAD', '--', '*'], ['diff', '--', '*'], ['diff', '--cached', '--', '*'], ['status'], ['show', 'HEAD:*']]) {
      // 用户环境里开着别的全局 pathspec 变量时 git 会拒绝与 literal 并用,一并压成 0
      expect(buildGitEnv(sub, { GIT_LITERAL_PATHSPECS: '0', GIT_GLOB_PATHSPECS: '1', GIT_ICASE_PATHSPECS: '1', GIT_NOGLOB_PATHSPECS: '1' })).toMatchObject({
        GIT_LITERAL_PATHSPECS: '1',
        GIT_GLOB_PATHSPECS: '0',
        GIT_NOGLOB_PATHSPECS: '0',
        GIT_ICASE_PATHSPECS: '0',
      });
    }
    expect(buildGitEnv(['commit', '-F', '-'])).not.toHaveProperty('GIT_LITERAL_PATHSPECS');
    expect(buildGitEnv(['commit', '-F', '-'], {}, { repoHooksConfirmed: true })).not.toHaveProperty('GIT_LITERAL_PATHSPECS');
  });
});

describe('stripTrailingNewline (path-valued git output)', () => {
  it('T10 removes exactly one trailing LF / CRLF and keeps every other whitespace', () => {
    expect(stripTrailingNewline('/r/gd \n')).toBe('/r/gd ');
    expect(stripTrailingNewline('/r/gd\t\r\n')).toBe('/r/gd\t');
    expect(stripTrailingNewline(' .git\n')).toBe(' .git');
    expect(stripTrailingNewline('.git')).toBe('.git');
    expect(stripTrailingNewline('\n')).toBe('');
    expect(stripTrailingNewline('a\n\n')).toBe('a\n');
  });
});
