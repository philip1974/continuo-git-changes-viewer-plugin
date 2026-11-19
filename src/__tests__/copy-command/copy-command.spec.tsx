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

// fish 的词法(只覆盖引号 / 转义 / 空白;fish 文档 "Quotes" 与 "Escaping characters"):单引号内 `\'` 与 `\\`
// 是转义,其余反斜杠原样;引号外 `\x` 是字面 x。未加引号的 ; # & | 等说明引号被提前闭合——抛错。
// 本机没有 fish 时用它断言;有 fish 时另用真实 fish 回读(见 Q9)。
function parseFish(line: string): string[] {
  const args: string[] = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      has = true;
      for (i++; i < line.length && line[i] !== "'"; i++) {
        if (line[i] === '\\' && (line[i + 1] === "'" || line[i + 1] === '\\')) i++;
        cur += line[i];
      }
      if (i >= line.length) throw new Error('unterminated quote');
    } else if (c === '\\') {
      has = true;
      cur += line[++i] ?? '';
    } else if (c === ' ') {
      if (has) args.push(cur);
      cur = '';
      has = false;
    } else if (/[;#&|<>()$*?~"{}]/.test(c)) {
      throw new Error(`unquoted metacharacter ${c}`);
    } else {
      has = true;
      cur += c;
    }
  }
  if (has) args.push(cur);
  return args;
}

const BACKSLASH = [
  "\\';touch PWNED;#", "a\\'; touch pwned #", "a\\\\'; touch pwned #", 'trail\\', "\\'", '\\', '\\\\', "'\\", "\\''", "a\\b'c\\'d", '\\ ', '~\\', '-\\n',
  "x\\'$(touch PWNED)'", 'dir\\sub/名字 \\ 带.md', "''\\''",
];
const which = (name: string): string | null => {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
};
// 真实 shell 回读:quoted 作为 printf 的一个参数
const readBack = (shell: string, flags: string[], quoted: string) =>
  execFileSync(shell, [...flags, '-c', `printf '%s\\0' ${quoted}`], { encoding: 'utf8', cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });

describe('shellQuotePath is not specific to POSIX sh: fish treats \\\' and \\\\ inside single quotes as escapes', () => {
  it('Q9 a path containing a backslash is written with every backslash and single quote outside the quotes (`\\\\`, `\\\'`), plain runs inside — one argument equal to the path under the fish quoting rules, where the POSIX-only form closes the quote early', () => {
    expect(shellQuotePath("\\';touch PWNED;#")).toBe("\\\\\\'';touch PWNED;#'");
    expect(shellQuotePath('a\\b')).toBe("'a'\\\\'b'");
    expect(shellQuotePath('trail\\')).toBe("'trail'\\\\");
    // fixture 证明:原来的写法(整体单引号,' 写成 '\'')在 fish 里把 `\'` 读成字面引号,引号提前闭合
    const posixOnly = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;
    expect(() => parseFish(`git diff -- ${posixOnly("\\';touch PWNED;#")}`)).toThrow(/unquoted metacharacter ;/);
    for (const path of [...BACKSLASH, ...HOSTILE, ...ORDINARY]) {
      const quoted = shellQuotePath(path)!;
      expect({ path, args: parseFish(`git diff -- ${quoted}`) }).toEqual({ path, args: ['git', 'diff', '--', path] });
      // 引号段之间总隔着一个转义字符:不出现"引号内的 ''"(zsh RC_QUOTES 下那是字面 ')
      if (path.includes('\\')) expect(quoted).not.toMatch(/[^\\']''/);
    }
    const fish = which('fish');
    if (fish) for (const path of [...BACKSLASH, ...HOSTILE]) expect({ path, out: readBack(fish, [], shellQuotePath(path)!) }).toEqual({ path, out: `${path}\0` });
  });

  it('Q10 the same text read back by real sh / bash / zsh (also with RC_QUOTES, and with history expansion on) / dash / ksh is that one path, and nothing else runs', () => {
    const shells: Array<[string, string[]]> = [
      ['/bin/sh', []], ['/bin/bash', []], ['/bin/bash', ['-H']], ['/bin/zsh', []], ['/bin/zsh', ['-o', 'rcquotes']], ['/bin/zsh', ['-o', 'banghist']],
      ['/bin/dash', []], ['/bin/ksh', []],
    ];
    const present = shells.filter(([shell]) => which(shell) !== null);
    // POSIX sh 与 zsh 是这条命令的主要去处:至少这两个必须真的跑到
    expect(present.map(([shell]) => shell)).toEqual(expect.arrayContaining(['/bin/sh', '/bin/zsh']));
    const paths = [...BACKSLASH, ...HOSTILE, ...ORDINARY];
    for (const [shell, flags] of present) {
      // 每个 shell 一次调用:每行一条 printf,各自回读一个参数(任何一条的引号没闭合都会让后面的全部错位)
      const script = paths.map((path) => `printf '%s\\0' ${shellQuotePath(path)!}`).join('\n');
      const out = execFileSync(shell, [...flags, '-c', script], { encoding: 'utf8', cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
      expect({ shell, flags, args: out.split('\0').slice(0, -1) }).toEqual({ shell, flags, args: paths });
    }
  });

  it('Q11 paths without a backslash keep the output they had', () => {
    expect(shellQuotePath("it's")).toBe("'it'\\''s'");
    expect(shellQuotePath("';touch pwned;'")).toBe("''\\'';touch pwned;'\\'''");
    expect(shellQuotePath('a b')).toBe("'a b'");
    expect(shellQuotePath('src/a.ts')).toBe('src/a.ts');
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
    // 命令按 POSIX shell 的引号规则书写(Windows 的 PowerShell / cmd 不适用),按钮上说明
    expect((screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement).title).toBe(
      'Copy this command. It is quoted for POSIX-style shells (sh, bash, zsh, fish), not for PowerShell or cmd.',
    );
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

  // 剪贴板写入会被拒绝(窗口没有焦点、权限被拒),也可能根本没有剪贴板 API:此前什么都不显示(rejection 未处理)
  it('Q12 the clipboard refuses the write: an error says the command was not copied, with the reason; no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => void unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      writeText.mockImplementation(() => Promise.reject(new Error('Document is not focused.')));
      const notifications = { show: vi.fn() };
      const app = { shell: { exec: vi.fn() }, notifications } as unknown as CoPluginApp;
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      render(<DiffView app={app} store={createGitStore()} change={change} diff={{ ok: false, reason: 'too-large', path: 'x', exactCommand: 'git diff -- x' }} />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ kind: 'error', message: 'Could not copy the command: Document is not focused.' }));
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('Q13 no clipboard API at all: the same error (banner without host notifications) instead of a silent no-op', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const store = createGitStore();
    render(<DiffView store={store} change={change} diff={{ ok: false, reason: 'too-large', path: 'x', exactCommand: 'git diff -- x' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() => expect(store.getState().banner).toEqual({ kind: 'error', message: 'Could not copy the command: clipboard unavailable', dismissable: true }));
  });
});
