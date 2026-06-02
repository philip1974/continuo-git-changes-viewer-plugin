// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import { createGitStore, type DiffMode } from '../../state/git-store';
import type { DiffResult } from '../../git/diff-fetcher';
import type { FileChange } from '../../git/status-scanner';
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

const diff: DiffResult = {
  ok: true,
  path: 'src/a.ts',
  original: 'old',
  modified: 'new',
  unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
  isUntracked: false,
};

async function renderPanel(change: FileChange, mode: DiffMode, diffResult = diff) {
  const exec = vi.fn().mockResolvedValue(result({ exitCode: 0 }));
  const notifications = { show: vi.fn() };
  const app = { shell: { exec }, notifications } as unknown as CoPluginApp;
  const store = createGitStore({
    load: async () => ({ repoRoot: '/repo', changes: [change] }),
    fetchDiff: async () => diffResult,
  });
  store.setState({ selected: { path: change.path, mode } });
  render(<GitViewerPanel app={app} store={store} />);
  await screen.findByText(change.path, { selector: '.cgv-path' });
  return { exec, notifications, store };
}

describe('lifted drawer hunk regressions', () => {
  it('T32 hunk Stage still opens the shared drawer and applies cached patch', async () => {
    const { exec } = await renderPanel(
      { path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
      'changed',
    );

    fireEvent.click(await screen.findByRole('button', { name: /Stage hunk at/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Stage hunk' }));

    await vi.waitFor(() => {
      expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['apply', '--cached']), expect.anything());
    });
  });

  it('T33 hunk Unstage still opens the shared drawer and reverse-applies cached patch', async () => {
    const { exec } = await renderPanel(
      { path: 'src/a.ts', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' },
      'staged',
    );

    fireEvent.click(await screen.findByRole('button', { name: /Unstage hunk at/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Unstage hunk' }));

    await vi.waitFor(() => {
      expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['apply', '--cached', '--reverse']), expect.anything());
    });
  });

  it('T34 hunk Discard still uses typed-confirm through the shared drawer', async () => {
    const { exec } = await renderPanel(
      { path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
      'changed',
    );

    fireEvent.click(await screen.findByRole('button', { name: /Discard hunk at/ }));
    fireEvent.change(screen.getByLabelText('Type "discard" to confirm:'), { target: { value: 'discard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard hunk' }));

    await vi.waitFor(() => {
      expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['apply', '--reverse']), expect.anything());
    });
  });
});
