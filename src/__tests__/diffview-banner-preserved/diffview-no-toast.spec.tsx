// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from '../../panel/DiffView';
import type { CoPluginApp } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';

describe('DiffView contextual banner preservation', () => {
  afterEach(() => cleanup());

  it('T9 keeps jump-back SDK fallback as an inline banner, not a toast', () => {
    const notifications = { show: vi.fn() };
    const app = { notifications } as unknown as CoPluginApp;
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

    fireEvent.click(screen.getByText('+new').closest('.cgv-line')!);

    expect(notifications.show).not.toHaveBeenCalled();
    expect(store.getState().banner?.message).toContain('SDK editor unavailable');
  });
});
