// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetRestoreCache } from '../../git/unstage-file';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';
import type { FileChange } from '../../git/status-scanner';
import { buildGitArgs } from '../../git/exec';

afterEach(() => {
  cleanup();
  _resetRestoreCache();
});

function result(partial: Partial<PluginShellExecResult>): PluginShellExecResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    ...partial,
  };
}

function renderWithChanges(
  changes: readonly FileChange[],
  exec: ReturnType<typeof vi.fn>,
  withNotifications = true,
) {
  const notifications = { show: vi.fn() };
  const shellExec = vi.fn(
    async (cmd: string, args: readonly string[], opts?: unknown) => {
      if (args.includes('rev-parse')) {
        return result({ exitCode: 0, stdout: 'HEAD\n' });
      }
      // 文件级操作之前对 index 的只读查询(子模块条目 / 路径之下的条目):一律空;其余交给用例的 exec
      if (args.includes('ls-files')) return result({ exitCode: 0 });
      return exec(cmd, args, opts);
    },
  );
  const app = {
    shell: { exec: shellExec },
    // 工作树里被操作的路径:普通文件,其父级(`/repo/src`)是目录(stage / discard 之前的查看)
    fs: {
      lstat: async (path: string) => {
        const isFile = /\.[a-z]+$/.test(path);
        return { size: 1, mtimeMs: 0, isFile, isDirectory: !isFile, isSymlink: false };
      },
    },
    ...(withNotifications ? { notifications } : {}),
  } as unknown as CoPluginApp;
  const refresh = vi.fn(async () => undefined);
  const store = createGitStore();
  store.setState({
    repoRoot: '/repo',
    changes: [...changes],
    selected: changes[0] ? { path: changes[0].path, mode: 'changed' } : null,
    refresh,
  });
  render(<GitViewerPanel app={app} store={store} />);
  refresh.mockClear();
  return { notifications, refresh, store };
}

describe('file-level write-op integration', () => {
  it('T35 stages an untracked row with git add and refreshes with success toast', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const { notifications, refresh } = renderWithChanges(
      [{ path: 'new.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' }],
      exec,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stage file new.txt' }));

    await vi.waitFor(() => {
      // 未跟踪行:名字来自 git 读目录,add 不固定 core.precomposeUnicode(见 exec T13)
      expect(exec).toHaveBeenCalledWith('git', buildGitArgs(['add', '--', 'new.txt'], { untrackedPathArgs: true }), expect.anything());
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(notifications.show).toHaveBeenCalledWith({ kind: 'info', message: 'Staged new.txt' });
  });

  it('T35b stages a tracked Changed row with the byte-exact argument pin (core.precomposeUnicode=false)', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const nfd = 'cafe\u0301.txt';
    renderWithChanges([{ path: nfd, status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }], exec);

    fireEvent.click(screen.getByRole('button', { name: `Stage file ${nfd}` }));

    await vi.waitFor(() => {
      expect(exec).toHaveBeenCalledWith('git', buildGitArgs(['add', '--', nfd]), expect.anything());
    });
    expect(buildGitArgs(['add', '--', nfd])).toContain('core.precomposeUnicode=false');
  });

  it('T36 discards a Changed MM file with checkout -- and never HEAD --', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const { refresh } = renderWithChanges(
      [{ path: 'src/a.ts', status: 'M', statusX: 'M', statusY: 'M', kind: 'text' }],
      exec,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Discard file src/a.ts' }));
    fireEvent.change(screen.getByLabelText('Type "discard" to confirm:'), { target: { value: 'discard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard file' }));

    await vi.waitFor(() => {
      expect(exec).toHaveBeenCalledWith('git', buildGitArgs(['checkout', '--', 'src/a.ts']), expect.anything());
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(exec.mock.calls[0]?.[1]).not.toContain('HEAD');
  });

  it('T37 unstages a staged row with restore --staged after capability probe', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }));
    const { refresh } = renderWithChanges(
      [{ path: 'src/a.ts', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' }],
      exec,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unstage file src/a.ts' }));

    await vi.waitFor(() => {
      expect(exec).toHaveBeenNthCalledWith(1, 'git', buildGitArgs(['restore', '-h']), expect.anything());
      expect(exec).toHaveBeenNthCalledWith(2, 'git', buildGitArgs(['restore', '--staged', '--', 'src/a.ts']), expect.anything());
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  it('T38 failed unstage shows error toast and does not refresh', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: 'unstage failed' }));
    const { notifications, refresh } = renderWithChanges(
      [{ path: 'src/a.ts', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' }],
      exec,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unstage file src/a.ts' }));

    await vi.waitFor(() => {
      expect(notifications.show).toHaveBeenCalledWith({ kind: 'error', message: 'unstage failed' });
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('T39 falls back to an info banner when success toast API is unavailable', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const { store } = renderWithChanges(
      [{ path: 'new.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' }],
      exec,
      false,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stage file new.txt' }));

    await vi.waitFor(() => {
      expect(store.getState().banner).toEqual({
        kind: 'info',
        message: 'Staged new.txt',
        dismissable: true,
      });
    });
  });
});
