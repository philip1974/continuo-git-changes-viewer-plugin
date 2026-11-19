// 测试辅助(不是规范):把 `git help --config` 写法的键模式展开成具体键,用来枚举
// "受限规则"与"已审计为安全的表"同时命中的键(重叠)。被 config-key-classification.spec.ts 与
// repo-safety-real-git(本机 git 的键列表)共用。
import { isKnownSafeConfigKey, isUnsafeConfigEntry } from '../../git/repo-safety';

/**
 * 经人工审查的重叠清单(快照)。受限优先(probeRepoSafety 先看受限规则),所以重叠的键结论一定是受限;
 * 但出现新的重叠说明"表里收了一个本应受限的键"或"新规则盖住了已审计的键",两种都要人看一眼再更新这里。
 * 现有四个都是按取值判定的键:表里收录,取值检查在查表之前。
 */
export const REVIEWED_OVERLAP: readonly string[] = ['core.bare', 'core.fsmonitor', 'diff.submodule', 'extensions.refstorage'];

const isWildcard = (segment: string) => segment === '*' || /^<[^<>]*>$/.test(segment);

/** 键列表里像键的行(去掉空行、说明行、includeIf 的 `hasconfig:` 条件写法)。 */
export const keyPatterns = (text: string): string[] =>
  text.split('\n').filter((l) => l !== '' && !/\s/.test(l) && !l.startsWith('hasconfig:') && l.includes('.'));

// 中间的通配段(subsection)取值:普通名字、带点的名字、空名字(`[filter ""]`),以及
// "名字的最后一段恰好是某个受限变量名 / 常见变量名"——切分不按 git 的规则时,这些最容易被归到另一个模式。
const SUBSECTIONS = [
  'x', 'a.b', '', 'https://h.example/p.git', 'a b',
  ...['clean', 'smudge', 'process', 'textconv', 'command', 'cmd', 'driver', 'program', 'uploadpack', 'receivepack',
    'allow', 'path', 'external', 'defaultkeycommand', 'url', 'remote', 'worktree', 'bare', 'enabled'].map((n) => `x.${n}`),
  'external', 'program', 'ssh', 'extension.x', 'customtransfer.x',
];

// 末尾的通配段(变量名)取值:不含点。
const NAMES = [
  'x', 'clean', 'smudge', 'process', 'textconv', 'command', 'cmd', 'driver', 'program', 'uploadpack', 'receivepack',
  'allow', 'path', 'external', 'defaultkeycommand', 'packobjectshook', 'recentobjectshook', 'askpass', 'gitproxy',
  'alternaterefscommand', 'worktree', 'bare', 'attributesfile', 'excludesfile', 'fsmonitor', 'submodule', 'refstorage',
];

/** 一个模式的全部具体化(通配段逐个取上面的样本;没有通配段就是它自己)。 */
export function instantiations(pattern: string): string[] {
  const segments = pattern.split('.');
  let keys = [''];
  segments.forEach((segment, i) => {
    const options = !isWildcard(segment) ? [segment] : i === segments.length - 1 ? NAMES : SUBSECTIONS;
    keys = keys.flatMap((prefix) => options.map((o) => (i === 0 ? o : `${prefix}.${o}`)));
  });
  return keys;
}

// 取值无关的判断用 'x';按取值判定的键(core.bare / core.fsmonitor / diff.submodule / extensions.refStorage)用 'x' 时受限。
const restricted = (key: string) => isUnsafeConfigEntry({ scope: 'local', key, value: 'x' });

/** 具体化之后同时"受限"又"在已审计表里"的键(去重、小写、排序)。 */
export function overlappingKeys(patterns: readonly string[]): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const key of instantiations(pattern)) {
      if (restricted(key) && isKnownSafeConfigKey(key)) found.add(key.toLowerCase());
    }
  }
  return [...found].sort();
}
