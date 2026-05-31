import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import type { FileChange } from './status-scanner';

// v0.1.3 hotfix: MergeView 必须接收两个全文（不是 filter unified diff +/-）。
// `original` = HEAD 版整个文件；`modified` = 当前 working tree 整个文件。
// `unifiedDiff` 保留供 hunk 跳转 / 调试 / placeholder 显示用。
export type DiffResult =
  | {
      ok: true;
      path: string;
      original: string; // HEAD 版全文；新文件为 ""
      modified: string; // working tree 全文；删除文件为 ""
      unifiedDiff: string;
      isUntracked: boolean;
    }
  | {
      ok: false;
      reason: 'too-large' | 'git-error';
      path: string;
      exactCommand: string;
      message?: string;
    };

function trackedCommand(path: string): string {
  return `git diff HEAD -- ${path}`;
}

function untrackedCommand(path: string): string {
  return `git diff --no-index --binary --no-color /dev/null ${path}`;
}

async function gitShowHead(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
): Promise<string> {
  // exit 128 if HEAD doesn't contain the path (new / renamed-to file)
  const r = await gitExec(app, repoRoot, ['show', `HEAD:${path}`]);
  return r.exitCode === 0 ? r.stdout : '';
}

async function shellCat(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
): Promise<string> {
  const r = await app.shell.exec('cat', [path], { cwd: repoRoot });
  return r.exitCode === 0 ? r.stdout : '';
}

export async function fetchDiff(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  change: FileChange,
): Promise<DiffResult> {
  const untracked = change.status === 'U';

  // Untracked: 没 HEAD 版；只显示 WT 全文（DiffView 走 NewFileView 分支）
  if (untracked) {
    const modified = await shellCat(app, repoRoot, change.path);
    return {
      ok: true,
      path: change.path,
      original: '',
      modified,
      unifiedDiff: '',
      isUntracked: true,
    };
  }

  const exactCommand = trackedCommand(change.path);
  const headPath = change.oldPath ?? change.path; // R<score> 用 oldPath 拿 HEAD 内容

  // 并发跑 3 个 shell 命令
  const [originalRaw, modifiedRaw, diffR] = await Promise.all([
    gitShowHead(app, repoRoot, headPath),
    change.status === 'D'
      ? Promise.resolve('')
      : shellCat(app, repoRoot, change.path),
    gitExec(app, repoRoot, ['diff', 'HEAD', '--', change.path]),
  ]);

  if (diffR.truncated) {
    return {
      ok: false,
      reason: 'too-large',
      path: change.path,
      exactCommand,
    };
  }
  if (diffR.exitCode !== 0) {
    return {
      ok: false,
      reason: 'git-error',
      path: change.path,
      exactCommand,
      message: diffR.stderr || diffR.stdout,
    };
  }

  return {
    ok: true,
    path: change.path,
    original: originalRaw,
    modified: modifiedRaw,
    unifiedDiff: diffR.stdout,
    isUntracked: false,
  };
}

// Untracked helper kept for backward compat in spec; not used in runtime.
export { untrackedCommand };
