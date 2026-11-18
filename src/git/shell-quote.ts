// 给"供用户复制、粘贴进终端"的命令文本用的路径转义。文件名来自不可信仓库:`a;touch x`、`$(…)`、反引号、
// 空格、换行都是合法文件名,原样拼进 `git diff -- <path>` 再粘贴就会执行 / 拆参。
// 插件自己运行的命令不经过 shell(参数数组直接交给 app.shell.exec),与此无关。

// 不需要引号的字符集:常规路径的输出保持原样。
const PLAIN = /^[A-Za-z0-9_./-]+$/;
// C0 控制字符、DEL、C1 控制字符。单引号里 shell 不解释它们,但粘贴这一步是终端在处理:换行会提交命令行,
// ESC 序列可被终端解释——含这些字符的路径不提供可粘贴的形式。
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// 含反斜杠的路径用的写法:`\` 与 `'` 都放到引号外、各用一个反斜杠转义(`\\`、`\'`),其余字符成段放进 `'…'`。
// 原因:fish 的单引号内 `\'` 与 `\\` 仍是转义(fish 文档 "Quotes")。POSIX 的写法(整体单引号,`'` 写成 `'\''`)
// 遇到文件名 `\';touch PWNED;#` 得到 `'\'\'';touch PWNED;#'`——fish 把两个 `\'` 都读成字面引号,在下一个 `'`
// 处闭合,`;touch PWNED` 成了第二条命令。引号外的 `\\` / `\'` 在 sh / bash / zsh / fish 里含义相同,引号内
// 只剩不含 `\` 和 `'` 的普通字符,四者解析结果一致。引号段之间总隔着转义字符,不会出现引号内的 `''`
// (zsh RC_QUOTES 下那表示字面 `'`)。与宿主 Continuo 的 terminal-drop-quote(posix 分支)同一写法。
function quotePortable(path: string): string {
  return path.replace(/[^\\']+|[\\']/g, (seg) => (seg === '\\' || seg === "'" ? `\\${seg}` : `'${seg}'`));
}

/**
 * 供粘贴进 POSIX 风格 shell(sh / bash / zsh / fish)的单参数写法;不适用于 PowerShell / cmd。
 * - 只含 `[A-Za-z0-9_./-]` 的路径原样返回;
 * - 不含反斜杠:整体包在 `'…'` 里,内嵌的 `'` 写成 `'\''`;
 * - 含反斜杠:见 quotePortable;
 * - 空串或含控制字符:返回 null(没有可安全粘贴的形式)。
 */
export function shellQuotePath(path: string): string | null {
  if (path === '' || CONTROL.test(path)) return null;
  if (PLAIN.test(path)) return path;
  if (path.includes('\\')) return quotePortable(path);
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
