// @vitest-environment jsdom
// 不可操作行:POSIX 上合法、但插件不肯传给 git 的文件名(`c:notes.txt`、`..\x`)。它们以前被静默丢弃——
// 若已暂存,面板不显示,`commit -F -` 却把它们一并提交。现在作为只读行显示。
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canDiscardFile } from '../../git/can-discard-file';
import { canDiscardHunk } from '../../git/can-discard-hunk';
import { canStageFile } from '../../git/can-stage-file';
import { canStageHunk, type SectionKind } from '../../git/can-stage-hunk';
import { canUnstageFile } from '../../git/can-unstage-file';
import { canUnstageHunk } from '../../git/can-unstage-hunk';
import { fetchDiff, type DiffResult } from '../../git/diff-fetcher';
import type { FileChange } from '../../git/status-scanner';
import { FileList, INOPERABLE_NOTE, INOPERABLE_STAGED_NOTE } from '../../panel/FileList';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import { createGitStore, firstSelectableEntry } from '../../state/git-store';
import type { CoPluginApp } from '../../sdk/types';

afterEach(() => cleanup());

const stagedOdd: FileChange = { path: 'c:notes.txt', status: 'A', statusX: 'A', statusY: ' ', kind: 'text', inoperable: true };
const changedOdd: FileChange = { path: '..\\x', status: 'M', statusX: ' ', statusY: 'M', kind: 'text', inoperable: true };
const untrackedOdd: FileChange = { path: 'd:new', status: 'U', statusX: '?', statusY: '?', kind: 'text', inoperable: true };
const both: FileChange = { path: 'a:b', status: 'M', statusX: 'M', statusY: 'M', kind: 'text', inoperable: true };
const ordinary: FileChange = { path: 'ok.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' };
const ODD = [stagedOdd, changedOdd, untrackedOdd, both];

const okDiff: DiffResult = { ok: true, path: 'x', original: 'a\n', modified: 'b\n', unifiedDiff: '@@ -1 +1 @@\n-a\n+b\n', isUntracked: false };

describe('inoperable entries: gating', () => {
  it('I1 no file-level or hunk-level action is offered for an inoperable entry in any section', () => {
    for (const change of ODD) {
      for (const section of ['staged', 'changed', 'untracked'] as SectionKind[]) {
        expect({
          path: change.path, section,
          stage: canStageFile(change, section), unstage: canUnstageFile(change, section), discard: canDiscardFile(change, section),
          stageHunk: canStageHunk(change, okDiff, section), unstageHunk: canUnstageHunk(change, okDiff, section), discardHunk: canDiscardHunk(change, okDiff, section),
        }).toEqual({ path: change.path, section, stage: false, unstage: false, discard: false, stageHunk: false, unstageHunk: false, discardHunk: false });
      }
    }
    // 对照:同样状态的普通文件有这些操作
    expect(canStageFile(ordinary, 'changed') && canDiscardFile(ordinary, 'changed') && canStageHunk(ordinary, okDiff, 'changed')).toBe(true);
    expect(canUnstageFile({ ...stagedOdd, path: 'n.txt', inoperable: undefined }, 'staged')).toBe(true);
  });

  it('I2 selection skips inoperable entries: the first selectable entry is the first ordinary one, and none when there are only inoperable ones', () => {
    expect(firstSelectableEntry([changedOdd, stagedOdd, ordinary])).toEqual({ path: 'ok.txt', mode: 'changed' });
    expect(firstSelectableEntry(ODD)).toBeNull();
  });

  it('I3 the store never asks for the diff of an inoperable entry (refresh auto-selection, explicit selectFile, loadDiff)', async () => {
    const fetch = vi.fn(async () => okDiff);
    const store = createGitStore({ load: async () => ({ repoRoot: '/repo', changes: ODD }), fetchDiff: fetch });
    await store.getState().refresh();
    expect(store.getState().selected).toBeNull();
    store.getState().selectFile('c:notes.txt', 'staged');
    await store.getState().loadDiff('..\\x', 'changed');
    expect(fetch).not.toHaveBeenCalled();
    expect(store.getState().selected).toBeNull();
  });

  it('I4 even if asked directly, fetchDiff refuses without starting any process', async () => {
    const exec = vi.fn();
    const app = { shell: { exec }, fs: { lstat: vi.fn() } } as unknown as CoPluginApp;
    for (const change of ODD) {
      for (const mode of ['changed', 'staged'] as const) {
        expect(await fetchDiff(app, '/repo', change, mode)).toMatchObject({ ok: false, reason: 'git-error' });
      }
    }
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('inoperable entries: file list rows', () => {
  function renderList(changes: FileChange[]) {
    const handlers = { onStageFile: vi.fn(), onUnstageFile: vi.fn(), onDiscardFile: vi.fn() };
    const store = createGitStore();
    const selectFile = vi.spyOn(store.getState(), 'selectFile');
    const view = render(<FileList store={store} changes={changes} {...handlers} />);
    return { ...view, ...handlers, selectFile };
  }
  const rowOf = (container: HTMLElement, section: string, path: string) =>
    [
      ...[...container.querySelectorAll('details.cgv-section')]
        .find((d) => d.querySelector('summary span')!.textContent === section)!
        .querySelectorAll('li.cgv-file-li'),
    ].find((li) => li.querySelector('.cgv-path')!.textContent === path) as HTMLElement;

  it('I5 a staged inoperable entry is listed in Staged with its path as plain text, counted, and explained: it will be part of the commit', () => {
    const { container } = renderList([stagedOdd, ordinary]);
    const row = rowOf(container, 'Staged', 'c:notes.txt');
    expect(row).toBeTruthy();
    expect(container.querySelector('details.cgv-section .cgv-count')!.textContent).toBe('1');
    expect(row.querySelector('.cgv-row-note')!.textContent).toBe(INOPERABLE_STAGED_NOTE);
    expect(INOPERABLE_STAGED_NOTE).toBe('Unsupported file name — cannot be viewed or changed here, but it is staged and a commit will include it. Use git in a terminal.');
    expect(row.querySelector('.cgv-status')!.textContent).toBe('+');
  });

  it('I6 in Changed / Untracked the note says the row cannot be viewed or changed here', () => {
    const { container } = renderList([changedOdd, untrackedOdd, both]);
    expect(rowOf(container, 'Changed', '..\\x').querySelector('.cgv-row-note')!.textContent).toBe(INOPERABLE_NOTE);
    expect(rowOf(container, 'Untracked', 'd:new').querySelector('.cgv-row-note')!.textContent).toBe(INOPERABLE_NOTE);
    expect(INOPERABLE_NOTE).toBe('Unsupported file name — cannot be viewed or changed here. Use git in a terminal.');
    // 同时出现在 Staged 与 Changed 的条目:两行各有说明
    expect(rowOf(container, 'Staged', 'a:b').querySelector('.cgv-row-note')!.textContent).toBe(INOPERABLE_STAGED_NOTE);
    expect(rowOf(container, 'Changed', 'a:b').querySelector('.cgv-row-note')!.textContent).toBe(INOPERABLE_NOTE);
  });

  it('I7 the row is not a control: no row button, no stage / unstage / discard buttons, clicking it selects nothing; ordinary rows next to it keep theirs', () => {
    const { container, selectFile, onStageFile, onUnstageFile, onDiscardFile } = renderList([stagedOdd, changedOdd, untrackedOdd, ordinary]);
    for (const [section, path] of [['Staged', 'c:notes.txt'], ['Changed', '..\\x'], ['Untracked', 'd:new']] as const) {
      const row = rowOf(container, section, path);
      expect(row.querySelectorAll('button')).toHaveLength(0);
      expect(row.querySelector('.cgv-file-row--readonly')).toBeTruthy();
      fireEvent.click(row.querySelector('.cgv-file-row--readonly')!);
      fireEvent.click(row.querySelector('.cgv-path')!);
    }
    expect(selectFile).not.toHaveBeenCalled();
    expect([onStageFile, onUnstageFile, onDiscardFile].some((f) => f.mock.calls.length > 0)).toBe(false);

    const ok = rowOf(container, 'Changed', 'ok.txt');
    expect(ok.querySelector('button.cgv-file-row')).toBeTruthy();
    expect(ok.querySelector('.cgv-row-note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stage file ok.txt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard file ok.txt' })).toBeTruthy();
  });

  it('I8 a path made of markup or control characters is rendered as text only', () => {
    const nasty: FileChange = { ...stagedOdd, path: 'c:<img src=x onerror=alert(1)>‮gnp.exe' };
    const { container } = renderList([nasty]);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.cgv-path')!.textContent).toBe(nasty.path);
  });
});

describe('inoperable entries: whole panel', () => {
  function setup(changes: FileChange[]) {
    // rev-parse --git-common-dir → `.git`;没有 hooks 目录(提交前的 hooks 检测结论为 none,不弹确认)
    const exec = vi.fn(async (_cmd: string, args: readonly string[], _opts?: unknown) => ({
      stdout: args.includes('--git-common-dir') ? '.git\n' : '', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false,
    }));
    const lstat = vi.fn(async (path: string) => {
      if (path === '/repo/.git/hooks') throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      return { size: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false };
    });
    const app = { shell: { exec }, fs: { lstat, listDir: vi.fn(async () => []) }, notifications: { show: vi.fn() } } as unknown as CoPluginApp;
    const store = createGitStore({
      // 指纹:exec 对 status 的回答是空输出,store 里放同一个值(提交前确认通过)
      load: async () => ({ repoRoot: '/repo', changes, statusFingerprint: '' }),
      fetchDiff: (repoRoot, change, mode) => fetchDiff(app, repoRoot, change, mode),
    });
    return { app, exec, lstat, store };
  }
  const mentions = (exec: ReturnType<typeof setup>['exec'], needle: string) =>
    exec.mock.calls.filter(([, args]) => args.some((a) => a.includes(needle)));

  it('I9 only inoperable entries staged: they are visible, Commit is enabled (the user sees what will be committed), and no git / cat argument ever contains their paths — before, during or after the commit', async () => {
    const { app, exec, lstat, store } = setup([stagedOdd, changedOdd, untrackedOdd]);
    const { container } = render(<GitViewerPanel app={app} store={store} />);
    await waitFor(() => expect(screen.getByText('c:notes.txt')).toBeTruthy());

    expect(screen.getByText('Select a file')).toBeTruthy();
    expect([...container.querySelectorAll('.cgv-row-note')].map((n) => n.textContent)).toEqual([INOPERABLE_STAGED_NOTE, INOPERABLE_NOTE, INOPERABLE_NOTE]);

    const commit = screen.getByRole('button', { name: 'Commit staged changes' }) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    expect(container.querySelector('.cgv-commit-hint')!.textContent).toBe('1 file(s) staged');
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'msg' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Commit staged changes' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    });
    await waitFor(() => expect(exec.mock.calls.some(([, args]) => args.includes('commit'))).toBe(true));

    for (const path of ['c:notes.txt', '..\\x', 'd:new']) expect({ path, calls: mentions(exec, path) }).toEqual({ path, calls: [] });
    expect(exec.mock.calls.every(([cmd]) => cmd === 'git')).toBe(true);
    expect(lstat.mock.calls.map(([path]) => path)).toEqual(['/repo/.git/hooks']);
  });

  it('I10 next to ordinary files: the ordinary one is auto-selected and its diff loaded; the inoperable rows stay inert', async () => {
    const { app, exec, store } = setup([stagedOdd, ordinary]);
    render(<GitViewerPanel app={app} store={store} />);
    await waitFor(() => expect(store.getState().selected).toEqual({ path: 'ok.txt', mode: 'changed' }));
    await waitFor(() => expect(mentions(exec, 'ok.txt').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText('c:notes.txt'));
    expect(store.getState().selected).toEqual({ path: 'ok.txt', mode: 'changed' });
    expect(mentions(exec, 'c:notes.txt')).toEqual([]);
  });
});
