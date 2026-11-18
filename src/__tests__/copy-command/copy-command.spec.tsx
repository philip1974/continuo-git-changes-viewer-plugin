// @vitest-environment jsdom
// "Diff too large" 占位里可复制的命令:文件名来自不可信仓库,粘贴进终端后必须恰好是一个参数。
import { execFileSync } from 'node:child_process';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDiff } from '../../git/diff-fetcher';
import { shellQuotePath } from '../../git/shell-quote';
import { DiffView } from '../../panel/DiffView';
import type { CoPluginApp } from '../../sdk/types';
import type { FileChange } from '../../git/status-scanner';
import { createGitStore } from '../../state/git-store';

// 用真实 /bin/sh 解析命令:把 `git` 定义成"逐个打印参数(NUL 结尾)"的函数,得到 sh 实际拆出的参数表
function argsSeenByShell(command: string): string[] {
  const script = `git() { for a in "$@"; do printf '%s\\0' "$a"; done; }\n${command}\n`;
  const out = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8', cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
  return out.split('\0').slice(0, -1);
}

// 截断的 diff → too-large 结果(带 exactCommand)
async function tooLarge(path: string, mode: 'changed' | 'staged' = 'changed') {
  const exec = vi.fn().mockResolvedValue({ stdout: 'partial', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: true });
  const lstat = vi.fn().mockResolvedValue({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false });
  const app = { shell: { exec }, fs: { lstat } } as unknown as CoPluginApp;
  const d = await fetchDiff(app, '/repo', { path, status: 'M', statusX: 'M', statusY: 'M', kind: 'text' }, mode);
  if (d.ok || d.reason !== 'too-large') throw new Error('expected a too-large result');
  return d;
}

const ORDINARY = ['large.txt', 'src/a.ts', 'src/panel/Diff-View_2.test.tsx', '-n', 'a..b', '.env'];
const HOSTILE = [
  'a b.txt', 'a;touch pwned', '$(touch pwned)', '`touch pwned`', '$HOME', "it's", "'", "''", "a'b'c", "';touch pwned;'",
  'a"b', 'a&b', 'a|b', '>out', '<in', '*', '?', '[a]', '~', '~root', '#x', '!x', '!!', 'a\\b', 'a\\', '{a,b}', 'a=b', '%s', '中文 文件.txt', 'd/名字 带 空格.md', 'é', '--help me',
];
const CONTROL = ['a\nb', 'a\rb', 'a\tb', 'a\x1b[31mb', 'a\x07', 'a\x7f', 'a\x9bb', 'a\n;touch pwned\n'];

describe('shellQuotePath', () => {
  it('Q1 ordinary paths are left exactly as they are', () => {
    for (const path of ORDINARY) expect(shellQuotePath(path)).toBe(path);
  });

  it('Q2 any other path is single-quoted with embedded quotes written as \'\\\'\' — a real /bin/sh reads it back as exactly one argument equal to the path', () => {
    expect(shellQuotePath('a b')).toBe("'a b'");
    expect(shellQuotePath("it's")).toBe("'it'\\''s'");
    for (const path of [...ORDINARY, ...HOSTILE]) {
      const quoted = shellQuotePath(path);
      expect(quoted).not.toBeNull();
      expect({ path, args: argsSeenByShell(`git ${quoted}`) }).toEqual({ path, args: [path] });
    }
  });

  it('Q3 a path with a newline or any other control character (C0, DEL, C1) has no pasteable form', () => {
    for (const path of CONTROL) expect({ path, quoted: shellQuotePath(path) }).toEqual({ path, quoted: null });
    expect(shellQuotePath('')).toBeNull();
  });
});

describe('the command offered by the "Diff too large" placeholder', () => {
  it('Q4 ordinary paths: the command text is unchanged', async () => {
    expect((await tooLarge('large.txt')).exactCommand).toBe('git diff -- large.txt');
    expect((await tooLarge('src/a.ts', 'staged')).exactCommand).toBe('git diff --cached -- src/a.ts');
  });

  it('Q5 hostile names: pasted into a real /bin/sh the command is `git diff [--cached] -- <that one path>` and nothing else runs', async () => {
    for (const path of HOSTILE) {
      const changed = await tooLarge(path);
      expect({ path, args: argsSeenByShell(changed.exactCommand!) }).toEqual({ path, args: ['diff', '--', path] });
      const staged = await tooLarge(path, 'staged');
      expect({ path, args: argsSeenByShell(staged.exactCommand!) }).toEqual({ path, args: ['diff', '--cached', '--', path] });
    }
  });

  it('Q6 names with control characters: no command is offered (exactCommand is null)', async () => {
    for (const path of CONTROL) expect({ path, cmd: (await tooLarge(path)).exactCommand }).toEqual({ path, cmd: null });
  });
});

describe('placeholder Copy button', () => {
  const change: FileChange = { path: 'x', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' };
  const writeText = vi.fn();
  const renderPlaceholder = (exactCommand: string | null) => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return render(<DiffView store={createGitStore()} change={change} diff={{ ok: false, reason: 'too-large', path: 'x', exactCommand }} />);
  };
  afterEach(() => {
    cleanup();
    writeText.mockReset();
  });

  it('Q7 copies exactly the quoted command that is shown', () => {
    const { container } = renderPlaceholder("git diff -- 'a;touch pwned'");
    expect(container.querySelector('code')!.textContent).toBe("git diff -- 'a;touch pwned'");
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText.mock.calls).toEqual([["git diff -- 'a;touch pwned'"]]);
  });

  it('Q8 no command available: the button is disabled with an explanation, nothing is shown as a command and nothing is copied', () => {
    const { container } = renderPlaceholder(null);
    const button = screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('No command to copy: this file name contains control characters and cannot be pasted into a terminal safely');
    expect(container.querySelector('code')).toBeNull();
    expect(screen.getByText('Diff too large')).toBeTruthy();
    fireEvent.click(button);
    expect(writeText).not.toHaveBeenCalled();
  });
});
