// 给"供用户复制、粘贴进终端"的命令文本用的路径转义。文件名来自不可信仓库:`a;touch x`、`$(…)`、反引号、
// 空格、换行都是合法文件名,原样拼进 `git diff -- <path>` 再粘贴就会执行 / 拆参。
// 插件自己运行的命令不经过 shell(参数数组直接交给 app.shell.exec),与此无关。

// 不需要引号的字符集:常规路径的输出保持原样。
const PLAIN = /^[A-Za-z0-9_./-]+$/;
// C0 控制字符、DEL、C1 控制字符。单引号里 shell 不解释它们,但粘贴这一步是终端在处理:换行会提交命令行,
// ESC 序列可被终端解释——含这些字符的路径不提供可粘贴的形式。
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * POSIX shell 的单引号转义:整体包在 `'…'` 里,内嵌的 `'` 写成 `'\''`。
 * 只含 `[A-Za-z0-9_./-]` 的路径原样返回;空串或含控制字符时返回 null(没有可安全粘贴的形式)。
 */
export function shellQuotePath(path: string): string | null {
  if (path === '' || CONTROL.test(path)) return null;
  if (PLAIN.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
