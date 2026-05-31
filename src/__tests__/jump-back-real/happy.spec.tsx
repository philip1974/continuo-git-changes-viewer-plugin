// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from '../../panel/DiffView';
import { createGitStore } from '../../state/git-store';
import type { CoPluginApp } from '../../sdk/types';

afterEach(() => {
  cleanup();
});

describe('jump-back happy path', () => {
  it('T1 leaves banner empty when editor applies the line jump', async () => {
    const openFile = vi.fn(async () => ({ ok: true, lineApplied: true }));
    const app = { editor: { openFile } } as unknown as CoPluginApp;
    const store = createGitStore();
    store.setState({ repoRoot: '/repo/' });

    render(
      <DiffView
        app={app}
        scopeReady={Promise.resolve('grant')}
        store={store}
        change={{ path: 'src/a.ts', status: 'M', kind: 'text' }}
        diff={{
          ok: true,
          path: 'src/a.ts',
          original: 'old\n',
          modified: 'new\n',
          unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
          isUntracked: false,
        }}
      />,
    );

    fireEvent.click(screen.getByText(/\+new/).closest('.cgv-line')!);

    await vi.waitFor(() => {
      expect(openFile).toHaveBeenCalledWith('/repo/src/a.ts', { line: 1 });
    });
    expect(store.getState().banner).toBeNull();
  });
});

