// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';
import type { FileChange } from '../../git/status-scanner';

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

const staged: FileChange = {
  path: 'src/a.ts',
  status: 'M',
  statusX: 'M',
  statusY: ' ',
  kind: 'text',
};

const partial: FileChange = {
  path: 'src/a.ts',
  status: 'M',
  statusX: 'M',
  statusY: 'M',
  kind: 'text',
};

describe('commit integration', () => {
  it('T32 GitViewerPanel renders CommitEditor', async () => {
    const store = createGitStore({
      load: async () => ({ repoRoot: '/repo', changes: [] }),
    });

    render(<GitViewerPanel store={store} />);

    expect(await screen.findByRole('region', { name: 'Commit changes' })).toBeTruthy();
  });

  it('T33 CommitEditor receives the staged file count', async () => {
    const store = createGitStore({
      load: async () => ({ repoRoot: '/repo', changes: [staged] }),
    });

    render(<GitViewerPanel store={store} />);

    expect(await screen.findByText('1 file(s) staged')).toBeTruthy();
  });

  it('T34 committing an MM staged selection reconciles back to changed mode', async () => {
    const afterCommit: FileChange = {
      path: 'src/a.ts',
      status: 'M',
      statusX: ' ',
      statusY: 'M',
      kind: 'text',
    };
    let loadCount = 0;
    const store = createGitStore({
      load: async () => {
        loadCount += 1;
        return {
          repoRoot: '/repo',
          changes: loadCount <= 1 ? [partial] : [afterCommit],
        };
      },
    });
    store.setState({
      repoRoot: '/repo',
      changes: [partial],
      selected: { path: 'src/a.ts', mode: 'staged' },
      commitMessage: 'subject',
    });
    const exec = vi.fn(
      async (_cmd: string, args: readonly string[]) => {
        if (args.includes('commit')) return result({ exitCode: 0 });
        if (args.includes('log')) return result({ exitCode: 0, stdout: 'subject\n' });
        return result({ exitCode: 0 });
      },
    );
    const app = {
      shell: { exec },
      notifications: { show: vi.fn() },
    } as unknown as CoPluginApp;

    render(<GitViewerPanel app={app} store={store} />);
    await screen.findByText('1 file(s) staged');
    fireEvent.change(screen.getByLabelText('Commit message'), {
      target: { value: 'subject' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    await vi.waitFor(() => {
      expect(store.getState().selected).toEqual({ path: 'src/a.ts', mode: 'changed' });
      expect(store.getState().commitMessage).toBe('');
      expect(store.getState().changes).toEqual([afterCommit]);
    });
  });

  it('T35 store.clear resets commitMessage', () => {
    const store = createGitStore();
    store.setState({ commitMessage: 'draft subject' });

    store.getState().clear();

    expect(store.getState().commitMessage).toBe('');
  });

  it('T36 refresh ticks preserve draft commit messages', async () => {
    const store = createGitStore({
      load: async () => ({ repoRoot: '/repo', changes: [staged] }),
    });
    store.setState({ commitMessage: 'draft subject' });

    await store.getState().refresh();

    expect(store.getState().commitMessage).toBe('draft subject');
  });
});

