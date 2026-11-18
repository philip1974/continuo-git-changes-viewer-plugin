// @vitest-environment jsdom
// 错误 / 提示文案里的 git 输出与仓库可控文本(stderr、hooksPath、hook 文件名\u2026\u2026)可以带控制字符与双向控制字符:
// 终端转义、把后半句倒过来显示的 U+202E、看不见的零宽字符。显示前一律可见化。文件列表里的文件名不在此列。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_VISIBLE_TEXT, visibleText } from '../../lib/visible-text';
import { GitViewerPanel } from '../../panel/GitViewerPanel';
import { PreviewDrawer } from '../../panel/PreviewDrawer';
import { CommitEditor } from '../../panel/CommitEditor';
import { DiffView } from '../../panel/DiffView';
import type { PluginManifest } from '../../sdk/types';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';
import { createGitStore } from '../../state/git-store';
import type { FileChange } from '../../git/status-scanner';

afterEach(() => cleanup());

describe('visibleText', () => {
  it('V1 C0 / C1 controls and DEL become a visible <U+XXXX>; a tab becomes a space', () => {
    expect(visibleText('a\u001b[31mred\u0007\u0000b')).toBe('a<U+001B>[31mred<U+0007><U+0000>b');
    expect(visibleText('x\u007fy\u0085z\u009bw')).toBe('x<U+007F>y<U+0085>z<U+009B>w');
    expect(visibleText('a\tb')).toBe('a b');
  });

  it('V2 bidi controls, the marks LRM / RLM / ALM and zero-width characters become visible', () => {
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]) {
      const hex = cp.toString(16).toUpperCase().padStart(4, '0');
      expect(visibleText(`a${String.fromCodePoint(cp)}b`), hex).toBe(`a<U+${hex}>b`);
    }
  });

  it('V3 line breaks (\\n, \\r\\n, \\r, U+2028, U+2029) fold into one space each run; text is trimmed', () => {
    expect(visibleText('error: one\nerror: two\r\nthree\rfour\u2028five\u2029six\n\n')).toBe('error: one error: two three four five six');
  });

  it(`V4 longer than ${'MAX_VISIBLE_TEXT'} code points: cut with an ellipsis, never inside a surrogate pair; ordinary text (CJK, emoji, U+FFFD) is unchanged`, () => {
    expect(MAX_VISIBLE_TEXT).toBe(500);
    const long = '\u{1F600}'.repeat(600);
    const cut = visibleText(long);
    expect(Array.from(cut)).toHaveLength(501);
    expect(cut.endsWith('\u{1F600}\u2026')).toBe(true);
    expect(visibleText('中文 \u{1F600} caf\uFFFD.txt')).toBe('中文 \u{1F600} caf\uFFFD.txt');
  });

  // 复核者实测:这些看不见的码位此前原样通过。现在的集合是 Cc + Cf + Default_Ignorable_Code_Point,另加 Hangul 填充字符。
  const hexOf = (cp: number) => cp.toString(16).toUpperCase().padStart(4, '0');
  it('V14 other invisible code points become visible too: tag characters, variation selectors, Hangul fillers, soft hyphen, CGJ, Mongolian vowel separator, invisible operators, deprecated format characters, interlinear annotation, musical format characters', () => {
    const cps = [
      0xe0001, 0xe0041, 0xe007f, // tag characters
      0xfe00, 0xfe0f, 0xe0100, 0xe01ef, // variation selectors
      0x115f, 0x1160, 0x3164, 0xffa0, // Hangul fillers
      0x00ad, 0x034f, 0x180e, 0x17b4, 0x17b5,
      0x2061, 0x2062, 0x2063, 0x2064,
      0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f,
      0xfff9, 0xfffa, 0xfffb,
      0x1d173, 0x1d17a,
      0x0600, 0x110bd, 0xe0fff,
    ];
    for (const cp of cps) {
      expect(visibleText(`a${String.fromCodePoint(cp)}b`), hexOf(cp)).toBe(`a<U+${hexOf(cp)}>b`);
    }
  });

  it('V15 visible text is left alone: combining marks, NBSP, ideographic space, CJK, emoji with skin tone, U+FFFD', () => {
    const text = `cafe${String.fromCodePoint(0x301)} a${String.fromCodePoint(0xa0)}b${String.fromCodePoint(0x3000)}中文 ${String.fromCodePoint(0x1f44d, 0x1f3fd)} ${String.fromCodePoint(0xfffd)}`;
    expect(visibleText(text)).toBe(text);
  });

  it('V16 the text is cut before invisible characters are replaced: no half-written <U+…> at the end, and the limit counts the original code points', () => {
    const rlo = String.fromCodePoint(0x202e);
    expect(visibleText(`${'a'.repeat(MAX_VISIBLE_TEXT - 1)}${rlo}${'b'.repeat(100)}`)).toBe(`${'a'.repeat(MAX_VISIBLE_TEXT - 1)}<U+202E>\u2026`);
    const zwsp = String.fromCodePoint(0x200b);
    expect(visibleText(zwsp.repeat(600))).toBe(`${'<U+200B>'.repeat(MAX_VISIBLE_TEXT)}\u2026`);
    const tag = String.fromCodePoint(0xe0041);
    // tag 字符是组合性的(Extend):整串是一个字形簇,超过上限 → 按码点截断;五位十六进制的码位同样不出现半截
    expect(visibleText(tag.repeat(600))).toBe(`${'<U+E0041>'.repeat(MAX_VISIBLE_TEXT)}\u2026`);
    // 跟在基字符后面的 tag 字符与它同属一个簇:簇放不下就整簇不要
    expect(visibleText(`${'a'.repeat(MAX_VISIBLE_TEXT - 1)}${tag}${tag}`)).toBe(`${'a'.repeat(MAX_VISIBLE_TEXT - 2)}\u2026`);
  });

  it('V17 the cut does not separate a base character from its combining marks; a single cluster longer than the limit is still cut (by code points)', () => {
    const acute = String.fromCodePoint(0x301);
    expect(visibleText(`${'a'.repeat(MAX_VISIBLE_TEXT - 1)}e${acute}${'z'.repeat(10)}`)).toBe(`${'a'.repeat(MAX_VISIBLE_TEXT - 1)}\u2026`);
    expect(visibleText(`${'a'.repeat(MAX_VISIBLE_TEXT - 2)}e${acute}z`)).toBe(`${'a'.repeat(MAX_VISIBLE_TEXT - 2)}e${acute}\u2026`);
    const huge = `e${acute.repeat(2000)}`;
    const cut = visibleText(huge);
    expect(Array.from(cut)).toHaveLength(MAX_VISIBLE_TEXT + 1);
    expect(cut.endsWith(`${acute}\u2026`)).toBe(true);
  });
});

const ok = (partial: Partial<PluginShellExecResult> = {}): PluginShellExecResult => ({
  stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false, ...partial,
});

const NASTY = 'fatal: \u202Eetirw ot elbanu\u202C\u001b[2J\nsecond line';
const SHOWN = 'fatal: <U+202E>etirw ot elbanu<U+202C><U+001B>[2J second line';

describe('the panel shows git output in errors and notices only in visible form', () => {
  function mount(opts: { notifications?: boolean } = {}) {
    const notifications = { show: vi.fn() };
    const changes: FileChange[] = [{ path: 'x.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }];
    const exec = vi.fn(async (_cmd: string, args: readonly string[]) =>
      args.includes('add') ? ok({ exitCode: 1, stderr: NASTY }) : ok());
    const app = {
      shell: { exec },
      fs: { lstat: async () => ({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false }) },
      ...(opts.notifications === false ? {} : { notifications }),
    } as unknown as CoPluginApp;
    const store = createGitStore();
    store.setState({ repoRoot: '/repo', changes, selected: null, statusFingerprint: 'fp', refresh: vi.fn(async (): Promise<void> => undefined) });
    const view = render(<GitViewerPanel app={app} store={store} />);
    return { ...view, store, notifications };
  }

  it('V5 a failing Stage: the error notification carries the visible form of git’s stderr', async () => {
    const { notifications } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Stage file x.txt' }));
    await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'error', message: SHOWN }));
  });

  it('V6 without host notifications the banner shows the visible form', async () => {
    const { container } = mount({ notifications: false });
    fireEvent.click(screen.getByRole('button', { name: 'Stage file x.txt' }));
    await vi.waitFor(() => expect(container.querySelector('.cgv-banner span')!.textContent).toBe(SHOWN));
  });

  it('V7 the status-unavailable alert and the restriction notice show the visible form', () => {
    const { store } = mount();
    act(() => store.setState({ statusError: NASTY }));
    expect(screen.getByRole('alert').textContent).toBe(
      `Could not read the repository status: ${SHOWN}. Commit and Amend are disabled until a refresh succeeds.`,
    );
    act(() => store.setState({ restriction: NASTY }));
    expect(screen.getByRole('alert').textContent).toBe(SHOWN);
  });

  it.each(['stage', 'discard-file'] as const)('V8 the preview drawer’s error line shows the visible form (%s)', (action) => {
    const { container } = render(
      <PreviewDrawer state={{ kind: 'error', action, filePath: 'x.txt', patch: 'p', error: NASTY }} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.querySelector('.cgv-preview-error')!.textContent).toBe(SHOWN);
  });
});

describe('the other places that show git output or repository-controlled text', () => {
  const editor = (opts: { commitError?: string; hooksPath?: string }) => {
    const notifications = { show: vi.fn() };
    const app = { shell: { exec: vi.fn() }, notifications } as unknown as CoPluginApp;
    const store = createGitStore();
    store.setState({ repoRoot: '/repo', commitMessage: 'm', statusFingerprint: 'fp', refresh: vi.fn(async (): Promise<void> => undefined) });
    render(
      <CommitEditor
        app={app}
        store={store}
        repoRoot="/repo"
        commitMessage="m"
        stagedCount={1}
        commit={async () => ({ ok: false as const, error: opts.commitError ?? 'x' })}
        readSubject={async () => 'm'}
        hasHeadCommit={async () => true}
        readHeadSha={async () => 'sha'}
        detectHooks={async () => (opts.hooksPath === undefined ? { kind: 'none' as const } : { kind: 'present' as const, hooks: [], hooksPath: opts.hooksPath })}
        readFingerprint={async () => 'fp'}
      />,
    );
    return { notifications };
  };

  it('V9 a failing commit: the error notification shows git’s output in visible form', async () => {
    const { notifications } = editor({ commitError: NASTY });
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'error', message: SHOWN }));
  });

  it('V10 the hooks prompt shows a repository-controlled core.hooksPath in visible form', async () => {
    editor({ hooksPath: NASTY });
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }));
    const prompt = await screen.findByRole('alert');
    expect(prompt.querySelector('.cgv-hooks-warning')!.textContent).toBe(
      `This repository sets core.hooksPath (${SHOWN}). Git hooks there will run when you commit.`,
    );
  });

  it('V11 a diff that failed shows git’s message in visible form', () => {
    const change: FileChange = { path: 'x.txt', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' };
    const { container } = render(
      <DiffView store={createGitStore()} change={change} diff={{ ok: false, reason: 'git-error', path: 'x.txt', message: NASTY } as never} />,
    );
    expect(container.querySelector('.cgv-diff-empty')!.textContent).toBe(SHOWN);
  });

  it('V12 a setup failure reported by the plugin shows the host’s message in visible form', async () => {
    class Base {
      constructor(readonly app: CoPluginApp, readonly manifest: PluginManifest) {}
      onload(): void {}
    }
    (globalThis as { co?: unknown }).co = { Plugin: Base, React: { createElement: vi.fn(() => null) }, PermissionError: class extends Error {}, z: {} };
    try {
      vi.resetModules();
      const Plugin = (await import('../../main')).default;
      const notifications = { show: vi.fn() };
      const app = {
        panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
        commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
        ribbon: { register: vi.fn(() => ({ dispose: vi.fn() })) },
        workspace: { getRoot: vi.fn(async () => '/repo') },
        fs: { requestScope: vi.fn(async () => { throw new Error(NASTY); }) },
        shell: { exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 1, signal: null, timedOut: false, truncated: false })), execStream: vi.fn() },
        dock: { openPanel: vi.fn() },
        notifications,
      } as unknown as CoPluginApp;
      const plugin = new Plugin(app, { id: 'git-viewer' } as PluginManifest);
      await plugin.onload();
      await plugin.scopeReady;
      expect(notifications.show).toHaveBeenCalledWith({ kind: 'error', message: `Setup failed: ${SHOWN}` });
      await plugin.onunload?.();
    } finally {
      (globalThis as { co?: unknown }).co = undefined;
      document.head.innerHTML = '';
    }
  });

  it('V13 a hunk action that fails (DiffView with its own drawer): the error notification shows git’s output in visible form', async () => {
    const notifications = { show: vi.fn() };
    const app = {
      shell: { exec: vi.fn(async () => ok({ exitCode: 1, stderr: NASTY })) },
      notifications,
    } as unknown as CoPluginApp;
    const store = createGitStore();
    store.setState({ repoRoot: '/repo' });
    render(
      <DiffView
        app={app}
        store={store}
        change={{ path: 'a.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' }}
        diff={{ ok: true, path: 'a.ts', original: 'old', modified: 'new', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n', isUntracked: false }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Stage hunk at / }));
    fireEvent.click(screen.getByRole('button', { name: 'Stage hunk' }));
    await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'error', message: SHOWN }));
  });
});

describe('the "Diff too large" placeholder', () => {
  it('V18 the command is shown in visible form (a U+202E in the file name does not reverse it); Copy still copies the exact command', async () => {
    const rlo = String.fromCodePoint(0x202e);
    const command = `git diff -- 'a${rlo}txt.exe'`;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const change: FileChange = { path: `a${rlo}txt.exe`, status: 'M', statusX: ' ', statusY: 'M', kind: 'text' };
    const { container } = render(
      <DiffView store={createGitStore()} change={change} diff={{ ok: false, reason: 'too-large', path: change.path, exactCommand: command }} />,
    );
    expect(container.querySelector('.cgv-placeholder code')!.textContent).toBe(`git diff -- 'a<U+202E>txt.exe'`);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(command);
  });
});
