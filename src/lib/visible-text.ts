/** 错误 / 提示文案的最大长度(码点,按输出计——替换成 `<U+XXXX>` 之后,不含省略号);更长的截断并加省略号。 */
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

const toVisible = (ch: string): string =>
  `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`;

/** 码点数(不是 UTF-16 码元数)。 */
function countPoints(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/**
 * 把要显示在错误 / 提示里的文本(git 的 stderr、仓库可控的配置值与文件名)变成可见、单行、有界的形式:
 * 控制字符、格式字符与默认可忽略字符替换成 `<U+XXXX>`(终端转义不会被当作样式、U+202E 不会把后半句倒过来显示、
 * 看不见的字符看得见);换行折叠成一个空格;制表符变空格;过长截断并加省略号。只用于提示文案——文件列表里的文件名照旧。
 *
 * 上限按**输出**计(替换之后的码点数,不含省略号):逐个字形簇生成输出并累加,放不下的那一簇整簇不要——不切开
 * `<U+…>`,也不把基字符与它的组合附加符拆开。此前(9282e46)按原文码点计、先截断后替换:每个不可见码点展开成
 * 8–9 个字符,输出可达约 4500 字符,超过宿主通知的上限(4096)而被宿主从半个 `<U+E00` 处截掉。
 * 第一个簇本身就放不下(大量叠加的组合符、一长串 tag 字符)时在簇内按码点截断,每个 `<U+…>` 仍是整的。
 */
export function visibleText(text: string, maxLength = MAX_VISIBLE_TEXT): string {
  const flat = text.replace(LINE_BREAKS, ' ').replace(/\t/g, ' ');
  let out = '';
  let size = 0;
  let cut = false;
  // segment 是惰性的:到上限即停,不扫描其余部分(单个超长的簇除外,见上)
  const units: Iterable<string> = segmenter
    ? (function* () { for (const { segment } of segmenter.segment(flat)) yield segment; })()
    : flat;
  for (const unit of units) {
    const shown = unit.replace(INVISIBLE, toVisible);
    const shownSize = countPoints(shown);
    if (size + shownSize <= maxLength) {
      out += shown;
      size += shownSize;
      continue;
    }
    cut = true;
    if (out === '') {
      for (const ch of unit) {
        const piece = ch.replace(INVISIBLE, toVisible);
        const pieceSize = countPoints(piece);
        if (size + pieceSize > maxLength) break;
        out += piece;
        size += pieceSize;
      }
    }
    break;
  }
  const trimmed = out.trim();
  return cut ? `${trimmed}\u2026` : trimmed;
}
