import { describe, expect, it, vi } from 'vitest';
import { buildGitArgs, buildGitEnv, gitExec, registerGitGuard } from '../../git/exec';
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
];
const NO_NETWORK = ['-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null'];
const ENV = {
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
      [...GLOBALS, ...NO_NETWORK, 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty'],
      { cwd: '/repo', env: { LANG: 'C', ...ENV } },
    );
  });

  it('T3 diff/show/log never run external diff, textconv or signature verification', () => {
    expect(buildGitArgs(['diff', '--cached', '--', 'a.ts'])).toEqual([
      ...GLOBALS, ...NO_NETWORK,
      'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--cached', '--', 'a.ts',
    ]);
    expect(buildGitArgs(['show', 'HEAD:a.ts'])).toEqual([
      ...GLOBALS, ...NO_NETWORK,
      'show', '--no-ext-diff', '--no-textconv', '--no-show-signature', 'HEAD:a.ts',
    ]);
    expect(buildGitArgs(['log', '-1', '--pretty=%B'])).toEqual([
      ...GLOBALS, ...NO_NETWORK,
      'log', '--no-ext-diff', '--no-textconv', '--no-show-signature', '-1', '--pretty=%B',
    ]);
  });

  it('T4 commit (runs user hooks) keeps hardening but does not inject the network block', async () => {
    const { app, exec } = makeApp();

    await gitExec(app, '/repo', ['commit', '-F', '-'], { input: 'msg' });

    const [, args, opts] = exec.mock.calls[0]!;
    expect(args).toEqual([...GLOBALS, 'commit', '-F', '-']);
    expect(args).not.toContain('protocol.allow=never');
    expect(args.some((a: string) => a.startsWith('core.hooksPath'))).toBe(false);
    expect(opts.env).toEqual({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: ':' });
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

  it('T9 non-commit calls set GIT_ALLOW_PROTOCOL to an empty list (beats repo protocol.<name>.allow); caller env cannot re-enable it; commit leaves it unset', () => {
    for (const sub of [['status'], ['show', 'HEAD:a'], ['diff'], ['add', '--', 'a'], ['rev-parse', 'HEAD']]) {
      expect(buildGitEnv(sub, { GIT_ALLOW_PROTOCOL: 'file:ssh:ext' })).toMatchObject({ GIT_ALLOW_PROTOCOL: '' });
    }
    expect(buildGitEnv(['commit', '-F', '-'])).not.toHaveProperty('GIT_ALLOW_PROTOCOL');
  });
});
