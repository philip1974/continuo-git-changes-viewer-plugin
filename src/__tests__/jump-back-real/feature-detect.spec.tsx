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

function makeApp(editor?: CoPluginApp['editor']): CoPluginApp {
  return {
    editor,
  } as unknown as CoPluginApp;
}

function renderJump(app: CoPluginApp) {
  const store = createGitStore();
  store.setState({ repoRoot: '/repo' });
  render(
    <DiffView
      app={app}
      scopeReady={Promise.resolve('grant')}
      store={store}
      change={{ path: 'src/a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }}
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
  return store;
}

describe('jump-back feature detection', () => {
  it('T1 shows fallback banner when app.editor is unavailable', async () => {
    const store = renderJump(makeApp(undefined));

    fireEvent.click(screen.getByText(/\+new/).closest('.cgv-line')!);

    await vi.waitFor(() => {
      expect(store.getState().banner?.message).toContain(
        'SDK editor unavailable',
      );
    });
  });

  it('T2 calls app.editor.openFile when editor SDK exists', async () => {
    const openFile = vi.fn(async () => ({ ok: true as const, lineApplied: true }));
    const store = renderJump(makeApp({ openFile }));

    fireEvent.click(screen.getByText(/\+new/).closest('.cgv-line')!);

    await vi.waitFor(() => {
      expect(openFile).toHaveBeenCalledWith('/repo/src/a.ts', { line: 1 });
    });
    expect(store.getState().banner).toBeNull();
  });
});
