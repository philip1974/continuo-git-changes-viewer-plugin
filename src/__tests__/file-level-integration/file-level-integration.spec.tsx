// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetRestoreCache } from '../../git/unstage-file';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';
import type { FileChange } from '../../git/status-scanner';

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
      if (args[0] === '--no-optional-locks' && args[1] === 'rev-parse') {
        return result({ exitCode: 0, stdout: 'HEAD\n' });
      }
      return exec(cmd, args, opts);
    },
  );
  const app = {
    shell: { exec: shellExec },
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
      expect(exec).toHaveBeenCalledWith('git', ['--no-optional-locks', 'add', '--', 'new.txt'], expect.anything());
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(notifications.show).toHaveBeenCalledWith({ kind: 'info', message: 'Staged new.txt' });
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
      expect(exec).toHaveBeenCalledWith('git', ['--no-optional-locks', 'checkout', '--', 'src/a.ts'], expect.anything());
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
      expect(exec).toHaveBeenNthCalledWith(1, 'git', ['--no-optional-locks', 'restore', '-h'], expect.anything());
      expect(exec).toHaveBeenNthCalledWith(2, 'git', ['--no-optional-locks', 'restore', '--staged', '--', 'src/a.ts'], expect.anything());
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
