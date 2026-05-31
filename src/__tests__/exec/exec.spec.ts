import { describe, expect, it, vi } from 'vitest';
import { gitExec } from '../../git/exec';
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

describe('gitExec read-only shell wrapper', () => {
  it('T1 prepends --no-optional-locks and sets GIT_OPTIONAL_LOCKS=0', async () => {
    const { app, exec } = makeApp();

    await gitExec(app, '/repo', ['status', '--porcelain=v1', '-z']);

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'status', '--porcelain=v1', '-z'],
      {
        cwd: '/repo',
        env: { GIT_OPTIONAL_LOCKS: '0' },
      },
    );
  });

  it('T2 preserves caller env but forces GIT_OPTIONAL_LOCKS=0', async () => {
    const { app, exec } = makeApp();

    await gitExec(app, '/repo', ['diff'], {
      env: { LANG: 'C', GIT_OPTIONAL_LOCKS: '1' },
    });

    expect(exec).toHaveBeenCalledWith('git', ['--no-optional-locks', 'diff'], {
      cwd: '/repo',
      env: { LANG: 'C', GIT_OPTIONAL_LOCKS: '0' },
    });
  });
});
