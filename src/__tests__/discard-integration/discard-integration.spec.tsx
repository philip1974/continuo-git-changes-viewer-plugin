// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from '../../panel/DiffView';
import { createGitStore } from '../../state/git-store';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';

afterEach(() => cleanup());

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

const diff = {
  ok: true as const,
  path: 'src/a.ts',
  original: 'old',
  modified: 'new',
  unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
  isUntracked: false,
};

function setup(exitCode: number, stderr = '') {
  const exec = vi.fn().mockResolvedValue(result({ exitCode, stderr }));
  const notifications = { show: vi.fn() };
  const app = { shell: { exec }, notifications } as unknown as CoPluginApp;
  const refresh = vi.fn(async () => undefined);
  const store = createGitStore();
  store.setState({ repoRoot: '/repo', refresh });
  render(
    <DiffView
      app={app}
      store={store}
      change={{ path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }}
      diff={diff}
    />,
  );
  return { exec, notifications, refresh };
}

function openAndConfirmDiscard() {
  fireEvent.click(screen.getByRole('button', { name: /Discard hunk at/ }));
  fireEvent.change(screen.getByLabelText('Type "discard" to confirm:'), {
    target: { value: 'discard' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Discard hunk' }));
}

describe('discard hunk integration', () => {
  it('T22 confirmed discard calls git apply --reverse without --cached and refreshes on success', async () => {
    const { exec, refresh, notifications } = setup(0);

    openAndConfirmDiscard();

    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'apply', '--reverse', '--whitespace=nowarn', '-'],
      expect.objectContaining({ input: expect.stringContaining('@@ -1 +1 @@') }),
    );
    expect(exec.mock.calls[0]?.[1]).not.toContain('--cached');
    // v0.3.2 hot-fix: success path shows an info toast so the user has
    // visible confirmation even when the panel becomes empty (selected→null
    // after the last Changed file was discarded). Error toasts continue
    // to use kind:'error' (asserted in T23).
    expect(notifications.show).toHaveBeenCalledWith({
      kind: 'info',
      message: expect.stringContaining('Hunk discarded'),
    });
  });

  it('T23 failed discard shows an error toast and does not refresh', async () => {
    const { notifications, refresh } = setup(1, 'discard failed');

    openAndConfirmDiscard();

    await vi.waitFor(() => {
      expect(notifications.show).toHaveBeenCalledWith({
        kind: 'error',
        message: 'discard failed',
      });
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('T24 cancel closes discard preview without shelling out', () => {
    const { exec } = setup(0);

    fireEvent.click(screen.getByRole('button', { name: /Discard hunk at/ }));
    fireEvent.change(screen.getByLabelText('Type "discard" to confirm:'), {
      target: { value: 'discard' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('region', { name: 'Discard hunk preview' })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});
