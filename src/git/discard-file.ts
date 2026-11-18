import type { CoPluginApp } from '../sdk/types';
import { gitExec } from './exec';
import { GITLINK_MODE, readIndexEntries } from './index-entry';
import { isSafeRepoRelativePath, UNSAFE_PATH_ERROR } from './path-utils';
import type { FileOpResult } from './stage-file';

// `git checkout -- <子模块>` 以 0 退出而什么都不做(不带 --recurse-submodules 时 checkout 不动子模块的工作树;
// 插件也不递归进子模块):照常执行的话面板会报 "Discarded sub",而条目原样还在。
export const SUBMODULE_DISCARD_ERROR =
  'This entry is a submodule: there is no file content to discard here. To undo its change, use git in a terminal ' +
  '(for example `git submodule update`, or check out the recorded commit inside the submodule).';

const PROBE_TIMEOUT_MS = 5_000;

export async function discardFile(
  app: Pick<CoPluginApp, 'shell'>,
  repoRoot: string,
  path: string,
): Promise<FileOpResult> {
  if (!isSafeRepoRelativePath(path)) return { ok: false, error: UNSAFE_PATH_ERROR };
  // 探测失败(null)不拦:不知道就照常 checkout——文件的丢弃不该因为一次探测超时而做不了。
  const entries = await readIndexEntries(app, repoRoot, path, PROBE_TIMEOUT_MS);
  if (entries?.some((entry) => entry.mode === GITLINK_MODE)) return { ok: false, error: SUBMODULE_DISCARD_ERROR };
  const result = await gitExec(app, repoRoot, ['checkout', '--', path], {
    timeoutMs: 10_000,
  });

  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: result.stderr || `git checkout -- exit ${result.exitCode ?? 'unknown'}`,
  };
}
