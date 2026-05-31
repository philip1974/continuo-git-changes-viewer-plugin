// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from '../../panel/DiffView';
import { createGitStore } from '../../state/git-store';
import type {
  CoPluginApp,
  EditorOpenFailureCode,
} from '../../sdk/types';

afterEach(() => {
  cleanup();
});

async function clickWithFailure(code: EditorOpenFailureCode) {
  const openFile = vi.fn(async () => ({
    ok: false as const,
    code,
    message: `${code} message`,
  }));
  const app = { editor: { openFile } } as unknown as CoPluginApp;
  const store = createGitStore();
  store.setState({ repoRoot: '/repo' });

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
        unifiedDiff: '@@ -2 +2 @@\n-old\n+new\n',
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

describe('jump-back failure fallback banners', () => {
  it.each([
    ['INVALID_PATH', 'Invalid path'],
    ['PERMISSION_DENIED', "Need 'fs' permission"],
    ['FS_NOT_FOUND', 'File not found'],
    ['FS_NOT_FILE', 'Not a regular file'],
    ['FS_DENIED', 'Cannot read file'],
    ['FS_IO', 'Read error'],
    ['EXCEPTION', 'Open failed'],
  ] as const)('T1-T7 maps %s', async (code, expected) => {
    await expect(clickWithFailure(code)).resolves.toContain(expected);
  });
});

