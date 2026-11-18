/** 错误 / 提示文案的最大长度(码点,按原文计,替换成 `<U+XXXX>` 之前);更长的截断并加省略号。 */
export const MAX_VISIBLE_TEXT = 500;

// 控制字符(Cc:C0 / DEL / C1)、格式字符(Cf:双向控制与方向标记、零宽字符、软连字符、不可见运算符、行间注释……)
// 与 Default_Ignorable_Code_Point(变体选择符、tag 字符、CGJ、Hangul 填充字符……)。Hangul 填充字符实测已在
// Default_Ignorable_Code_Point 内(Node 24 / V8),仍显式列出,不依赖引擎的 Unicode 版本。
// 换行、制表符先行处理(见下),不会走到这里。
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u115F\u1160\u3164\uFFA0]/gu;
const LINE_BREAKS = /(?:\r\n|[\n\r\u2028\u2029])+/g;

const segmenter: { segment(text: string): Iterable<{ segment: string }> } | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/**
 * 取前 maxLength 个码点(不切开代理对);能做到时在字形簇边界处截断——基字符与它的组合附加符不拆开。
 * 单个字形簇本身就超过上限(大量叠加的组合符)时按码点截断。返回 null 表示没有超长。
 */
function cut(text: string, maxLength: number): string | null {
  const points = Array.from(text);
  if (points.length <= maxLength) return null;
  if (segmenter) {
    // 逐簇累加(segment 是惰性的,到上限即停):完整的簇才保留
    let kept = '';
    let count = 0;
    for (const { segment } of segmenter.segment(text)) {
      const size = Array.from(segment).length;
      if (count + size > maxLength) break;
      kept += segment;
      count += size;
    }
    if (kept !== '') return kept;
  }
  return points.slice(0, maxLength).join('');
}

/**
 * 把要显示在错误 / 提示里的文本(git 的 stderr、仓库可控的配置值与文件名)变成可见、单行、有界的形式:
 * 控制字符、格式字符与默认可忽略字符替换成 `<U+XXXX>`(终端转义不会被当作样式、U+202E 不会把后半句倒过来显示、
 * 看不见的字符看得见);换行折叠成一个空格;制表符变空格;过长截断。先截断、后替换:结尾不会出现半截的 `<U+…>`。
 * 只用于提示文案——文件列表里的文件名照旧。
 */
export function visibleText(text: string, maxLength = MAX_VISIBLE_TEXT): string {
  const flat = text.replace(LINE_BREAKS, ' ').replace(/\t/g, ' ');
  const kept = cut(flat, maxLength);
  const shown = (kept ?? flat)
    .replace(INVISIBLE, (ch) => `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`)
    .trim();
  return kept === null ? shown : `${shown}\u2026`;
}
