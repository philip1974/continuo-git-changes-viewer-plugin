// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';
import { buildGitArgs } from '../../git/exec';

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

describe('amend integration', () => {
  it('T34 GitViewerPanel passes amend state to CommitEditor', async () => {
    const store = createGitStore({
      load: async () => ({ repoRoot: '/repo', changes: [] }),
    });
    store.setState({ amend: true, commitMessage: 'head subject' });
    const app = {
      shell: { exec: vi.fn().mockResolvedValue(result({ exitCode: 0, stdout: 'HEAD\n' })) },
    } as unknown as CoPluginApp;

    render(<GitViewerPanel app={app} store={store} />);

    expect(await screen.findByRole('button', { name: 'Amend last commit' })).toBeTruthy();
  });

  it('T35 amend roundtrip uses --amend and clears amend state', async () => {
    const store = createGitStore();
    store.setState({
      repoRoot: '/repo',
      changes: [{ path: 'src/a.ts', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' }],
      commitMessage: 'new subject',
      amend: true,
      refresh: vi.fn(async () => undefined),
    });
    const exec = vi.fn(async (_cmd: string, args: readonly string[]) => {
      if (args.includes('--git-common-dir')) return result({ exitCode: 0, stdout: '.git\n' });
      if (args.includes('rev-parse')) return result({ exitCode: 0, stdout: args.includes('--verify') ? 'HEAD\n' : 'after\n' });
      if (args.includes('commit')) return result({ exitCode: 0 });
      if (args.includes('log')) return result({ exitCode: 0, stdout: 'new subject\n' });
      return result({ exitCode: 0 });
    });
    const app = {
      shell: { exec },
      fs: {
        listDir: async () => [],
        stat: async () => ({ size: 0, mtimeMs: 0, isFile: false, isDirectory: true, isSymlink: false }),
      },
      notifications: { show: vi.fn() },
    } as unknown as CoPluginApp;

    render(<GitViewerPanel app={app} store={store} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Amend last commit' }));

    await vi.waitFor(() => {
      expect(exec).toHaveBeenCalledWith(
        'git',
        buildGitArgs(['commit', '--amend', '-F', '-']),
        expect.objectContaining({ input: 'new subject' }),
      );
      expect(store.getState().amend).toBe(false);
      expect(store.getState().commitMessage).toBe('');
    });
  });

  it('T36 store.clear resets amend', () => {
    const store = createGitStore();
    store.setState({ amend: true, commitMessage: 'head subject' });

    store.getState().clear();

    expect(store.getState().amend).toBe(false);
  });
});

