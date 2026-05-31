import type {
  CoPluginApp,
  PluginShellExecOptions,
  PluginShellExecResult,
} from '../sdk/types';

export interface GitExecOptions
  extends Pick<PluginShellExecOptions, 'timeoutMs' | 'maxOutputBytes' | 'env'> {}

export async function gitExec(
  app: Pick<CoPluginApp, 'shell'>,
  cwd: string,
  args: readonly string[],
  opts: GitExecOptions = {},
): Promise<PluginShellExecResult> {
  return app.shell.exec('git', ['--no-optional-locks', ...args], {
    cwd,
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: opts.maxOutputBytes,
    env: {
      ...(opts.env ?? {}),
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
}
