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

describe('unstage hunk integration', () => {
  it('T23 staged-mode DiffView renders Unstage and successful confirm refreshes', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
    const app = { shell: { exec }, notifications: { show: vi.fn() } } as unknown as CoPluginApp;
    const refresh = vi.fn(async () => undefined);
    const store = createGitStore();
    store.setState({ repoRoot: '/repo', refresh });

    render(
      <DiffView
        app={app}
        store={store}
        mode="staged"
        change={{ path: 'src/a.ts', status: 'M', statusX: 'M', statusY: 'M', kind: 'text' }}
        diff={diff}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Unstage hunk at/ }));
    expect(screen.getByRole('region', { name: 'Unstage hunk preview' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unstage hunk' }));

    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(exec).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['--reverse']),
      expect.objectContaining({ input: expect.stringContaining('@@ -1 +1 @@') }),
    );
  });

  it('T24 failed unstage shows error and does not refresh', async () => {
    const notifications = { show: vi.fn() };
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 1, stderr: 'reverse failed' }));
    const app = { shell: { exec }, notifications } as unknown as CoPluginApp;
    const refresh = vi.fn(async () => undefined);
    const store = createGitStore();
    store.setState({ repoRoot: '/repo', refresh });

    render(
      <DiffView
        app={app}
        store={store}
        mode="staged"
        change={{ path: 'src/a.ts', status: 'M', statusX: 'M', statusY: 'M', kind: 'text' }}
        diff={diff}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Unstage hunk at/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Unstage hunk' }));

    await vi.waitFor(() => {
      expect(notifications.show).toHaveBeenCalledWith({
        kind: 'error',
        message: 'reverse failed',
      });
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
