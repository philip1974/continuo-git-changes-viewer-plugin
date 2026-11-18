/** 错误 / 提示文案的最大长度(码点);更长的截断并加省略号。 */
export const MAX_VISIBLE_TEXT = 500;

// C0 / DEL / C1 控制字符;双向控制(U+202A–202E 嵌入与覆盖、U+2066–2069 隔离)与方向标记 LRM / RLM / ALM;
// 零宽字符(ZWSP / ZWNJ / ZWJ / WORD JOINER / BOM)。换行、制表符另行处理(见下)。
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\u2060\uFEFF]/g;
const LINE_BREAKS = /(?:\r\n|[\n\r\u2028\u2029])+/g;

/**
 * 把要显示在错误 / 提示里的文本(git 的 stderr、仓库可控的配置值与文件名)变成可见、单行、有界的形式:
 * 控制字符、双向控制与零宽字符替换成 `<U+XXXX>`(终端转义不会被当作样式、U+202E 不会把后半句倒过来显示、
 * 看不见的字符看得见);换行折叠成一个空格;制表符变空格;过长截断。只用于提示文案——文件列表里的文件名照旧。
 */
export function visibleText(text: string, maxLength = MAX_VISIBLE_TEXT): string {
  const shown = text
    .replace(LINE_BREAKS, ' ')
    .replace(/\t/g, ' ')
    .replace(INVISIBLE, (ch) => `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`)
    .trim();
  const points = Array.from(shown);
  return points.length > maxLength ? `${points.slice(0, maxLength).join('')}\u2026` : shown;
}
