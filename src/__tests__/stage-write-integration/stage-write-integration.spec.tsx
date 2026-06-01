// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDiff } from '../../git/diff-fetcher';
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

function appWithApply(exitCode: number, stderr = '') {
  const exec = vi.fn().mockResolvedValue(result({ exitCode, stderr }));
  const notifications = { show: vi.fn() };
  return {
    app: { shell: { exec }, notifications } as unknown as CoPluginApp,
    exec,
    notifications,
  };
}

const twoHunkDiff = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  '@@ -20,2 +20,3 @@',
  ' context',
  '+later',
  '',
].join('\n');

describe('stage hunk integration', () => {
  it('T26 clicking the second hunk previews exactly that hunk and successful Stage refreshes silently', async () => {
    const { app, notifications } = appWithApply(0);
    const refresh = vi.fn(async () => undefined);
    const store = createGitStore();
    store.setState({ repoRoot: '/repo' });
    store.setState({ refresh });

    render(
      <DiffView
        app={app}
        store={store}
        change={{ path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }}
        diff={{
          ok: true,
          path: 'src/a.ts',
          original: 'old',
          modified: 'new',
          unifiedDiff: twoHunkDiff,
          isUntracked: false,
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /Stage hunk at/ })[1]!);
    const drawer = screen.getByRole('region', { name: 'Stage hunk preview' });
    const patchPreview = within(drawer).getByText((text) => text.includes('@@ -20,2 +20,3 @@'));
    expect(patchPreview.textContent).toContain('@@ -20,2 +20,3 @@');
    expect(patchPreview.textContent).not.toContain('@@ -1,2 +1,2 @@');

    fireEvent.click(screen.getByRole('button', { name: 'Stage hunk' }));

    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(notifications.show).not.toHaveBeenCalled();
  });

  it('T27 failed apply shows an error toast and leaves the store unrefreshed', async () => {
    const { app, notifications } = appWithApply(1, 'patch failed');
    const refresh = vi.fn(async () => undefined);
    const store = createGitStore();
    store.setState({ repoRoot: '/repo', refresh });

    render(
      <DiffView
        app={app}
        store={store}
        change={{ path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }}
        diff={{
          ok: true,
          path: 'src/a.ts',
          original: 'old',
          modified: 'new',
          unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
          isUntracked: false,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Stage hunk at/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Stage hunk' }));

    await vi.waitFor(() => {
      expect(notifications.show).toHaveBeenCalledWith({
        kind: 'error',
        message: 'patch failed',
      });
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('T28 falls back to an inline error banner when notifications are unavailable', async () => {
    const exec = vi.fn().mockResolvedValue(result({ exitCode: 1, stderr: '' }));
    const app = { shell: { exec } } as unknown as CoPluginApp;
    const store = createGitStore();
    store.setState({ repoRoot: '/repo' });

    render(
      <DiffView
        app={app}
        store={store}
        change={{ path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }}
        diff={{
          ok: true,
          path: 'src/a.ts',
          original: 'old',
          modified: 'new',
          unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
          isUntracked: false,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Stage hunk at/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Stage hunk' }));

    await vi.waitFor(() => {
      expect(store.getState().banner).toEqual({
        kind: 'error',
        message: 'git apply exit 1',
        dismissable: true,
      });
    });
  });

  it('T29 fetchDiff uses plain git diff for changed rows, not git diff HEAD', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue(result({ stdout: 'diff --git a/src/a.ts b/src/a.ts\n' }));
    const app = { shell: { exec } } as unknown as CoPluginApp;

    await fetchDiff(app, '/repo', {
      path: 'src/a.ts',
      status: 'M',
      statusX: 'M',
      statusY: 'M',
      kind: 'text',
    });

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'diff', '--', 'src/a.ts'],
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(exec).not.toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'diff', 'HEAD', '--', 'src/a.ts'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });
});
