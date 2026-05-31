// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from '../../panel/DiffView';
import { createGitStore } from '../../state/git-store';
import type {
  CoPluginApp,
  EditorOpenSuccessReason,
} from '../../sdk/types';

afterEach(() => {
  cleanup();
});

async function clickWithReason(reason: EditorOpenSuccessReason) {
  const openFile = vi.fn(async () => ({
    ok: true as const,
    lineApplied: false,
    reason,
  }));
  const app = { editor: { openFile } } as unknown as CoPluginApp;
  const store = createGitStore();
  store.setState({ repoRoot: '/repo' });

  render(
    <DiffView
      app={app}
      scopeReady={Promise.resolve('grant')}
      store={store}
      change={{ path: 'README.md', status: 'M', kind: 'text' }}
      diff={{
        ok: true,
        path: 'README.md',
        original: 'old\n',
        modified: 'new\n',
        unifiedDiff: '@@ -7 +7 @@\n-old\n+new\n',
        isUntracked: false,
      }}
    />,
  );

  fireEvent.click(screen.getByText(/\+new/).closest('.cgv-line')!);
  await vi.waitFor(() => {
    expect(store.getState().banner).not.toBeNull();
  });
  return store.getState().banner!.message;
}

describe('jump-back success fallback banners', () => {
  it.each([
    ['no-line-arg', 'Opened README.md'],
    ['milkdown-engine', 'cannot jump to line in Markdown editor'],
    ['line-out-of-range', 'line 7 is beyond file end'],
    ['tab-not-mounted', 'editor not mounted'],
  ] as const)('T1-T4 maps %s', async (reason, expected) => {
    await expect(clickWithReason(reason)).resolves.toContain(expected);
  });
});

