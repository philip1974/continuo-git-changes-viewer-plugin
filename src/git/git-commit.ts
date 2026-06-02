import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';

export interface CommitResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly timedOut?: boolean;
  readonly truncated?: boolean;
  readonly stderr?: string;
  readonly stdout?: string;
  readonly exitCode?: number | null;
}

export interface GitCommitOptions {
  readonly amend?: boolean;
}

export function formatGitCommitError(
  result: {
    readonly timedOut?: boolean;
    readonly truncated?: boolean;
    readonly stderr?: string;
    readonly stdout?: string;
    readonly exitCode?: number | null;
  },
): string {
  if (result.timedOut) return 'Commit timed out after 120s';
  if (result.truncated) return 'Commit output truncated; check terminal';

  const stderr = (result.stderr ?? '').trim();
  if (stderr) return stderr;

  const stdout = (result.stdout ?? '').trim();
  if (stdout) return stdout;

  return `git commit exit ${result.exitCode ?? 'unknown'}`;
}

export async function gitCommit(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  message: string,
  options: GitCommitOptions = {},
): Promise<CommitResult> {
  const args = options.amend
    ? ['commit', '--amend', '-F', '-']
    : ['commit', '-F', '-'];
  const result = await gitExec(app, repoRoot, args, {
    input: message,
    timeoutMs: 120_000,
  });

  if (result.exitCode === 0) return { ok: true };

  return {
    ok: false,
    timedOut: result.timedOut,
    truncated: result.truncated,
    stderr: result.stderr,
    stdout: result.stdout,
    exitCode: result.exitCode,
    error: formatGitCommitError(result),
  };
}

export async function readLastCommitSubject(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
): Promise<string | null> {
  const result = await gitExec(app, repoRoot, ['log', '-1', '--pretty=%s'], {
    timeoutMs: 5_000,
  });
  if (result.exitCode !== 0) return null;

  const subject = result.stdout.trim();
  return subject === '' ? null : subject;
}
