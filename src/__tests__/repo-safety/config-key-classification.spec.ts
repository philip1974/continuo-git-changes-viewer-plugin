// 分类表一致性:受限规则(repo-safety.ts)与已审计表(known-config-keys.ts)对同一个键的判定
// 必须按 git 自己的切分(section = 第一个点之前,变量名 = 最后一个点之后,subsection = 中间全部,可以为空、
// 可以含点)得出,且两者的重叠是固定的、经人工审查的一小份清单。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { KNOWN_SAFE_CONFIG_KEYS, parseConfigKeyList, splitConfigKey } from '../../git/known-config-keys';
import { isKnownSafeConfigKey, isUnsafeConfigEntry, probeRepoSafety } from '../../git/repo-safety';
import type { CoPluginApp, PluginShellExecResult } from '../../sdk/types';
import { instantiations, keyPatterns, overlappingKeys, REVIEWED_OVERLAP } from './key-overlap';

const fixture = (version: '2.50.1' | '2.56.1') =>
  readFileSync(join(__dirname, 'fixtures', `git-help-config-${version}.txt`), 'utf8');
const HELP_2_50 = fixture('2.50.1');
const HELP_2_56 = fixture('2.56.1');

const local = (key: string, value = 'x') => ({ scope: 'local', key, value });
const classify = (key: string) => ({
  key,
  restricted: isUnsafeConfigEntry(local(key)),
  reviewed: isKnownSafeConfigKey(key),
});

const result = (stdout: string): PluginShellExecResult => ({ stdout, stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false });
/** 仓库作用域只有这一个键时的结论;`git help --config` 返回 help。 */
async function verdictFor(key: string, value: string, help = HELP_2_56) {
  const exec = vi.fn(async (_cmd: string, args: readonly string[]) =>
    args.includes('--show-scope')
      ? result(`local\0core.bare\nfalse\0local\0${key}\n${value}\0`)
      : args.includes('--is-inside-work-tree')
        ? result('true\n\n/repo/.git\n/repo/.git\n/repo\n')
        : args.slice(-2).join(' ') === 'help --config'
          ? result(help)
          : result(''),
  );
  const fs = {
    listDir: async () => [],
    lstat: async () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    },
  };
  return probeRepoSafety({ shell: { exec }, fs } as unknown as CoPluginApp, '/repo');
}

describe('splitConfigKey (git\'s own rule: section . subsection . name)', () => {
  it.each([
    ['core.bare', { section: 'core', subsection: null, name: 'bare' }],
    ['Core.BARE', { section: 'core', subsection: null, name: 'bare' }],
    ['remote.origin.url', { section: 'remote', subsection: 'origin', name: 'url' }],
    // `[remote "a.uploadpack"] url = x`
    ['remote.a.uploadpack.url', { section: 'remote', subsection: 'a.uploadpack', name: 'url' }],
    // `[branch "x.remote"] merge = refs/heads/x`
    ['branch.x.remote.merge', { section: 'branch', subsection: 'x.remote', name: 'merge' }],
    ['url.https://GitHub.com/.insteadof', { section: 'url', subsection: 'https://GitHub.com/', name: 'insteadof' }],
    // `[filter ""] clean = ...`:空 subsection 与"没有 subsection"不同(git 的 parse_config_key 同样区分)
    ['filter..clean', { section: 'filter', subsection: '', name: 'clean' }],
    ['filter.a b.clean', { section: 'filter', subsection: 'a b', name: 'clean' }],
    ['filter.a\rb.clean', { section: 'filter', subsection: 'a\rb', name: 'clean' }],
  ])('C1 %j', (key, parts) => {
    expect(splitConfigKey(key)).toEqual(parts);
  });

  it.each(['', 'nodot', '.x', 'x.', '.', 'a..'])('C1b %j is not a config key → null', (key) => {
    expect(splitConfigKey(key)).toBeNull();
  });
});

describe('restricted rules and the reviewed table split keys the way git does', () => {
  // [键, 受限?, 在已审计表里?];注释是产生这个键的 config 写法
  const CASES: ReadonlyArray<readonly [key: string, restricted: boolean, reviewed: boolean]> = [
    // remote.<name>.*
    ['remote.a.uploadpack.url', false, true], // [remote "a.uploadpack"] url —— 名为 a.uploadpack 的 remote 的 url
    ['remote.a.url.uploadpack', true, false], // [remote "a.url"] uploadpack
    ['remote.a.b.receivepack', true, false],
    ['remote..uploadpack', true, false], // [remote ""] uploadpack
    ['remote..url', false, true],
    ['remote.uploadpack', false, false], // 没有 subsection:git 不读
    ['remote.a.uploadpack.gh-resolved', false, false],
    // branch.<name>.*
    ['branch.x.remote.merge', false, true], // [branch "x.remote"] merge
    ['branch.feat/a.b.remote', false, true],
    ['branch..remote', false, true],
    ['branch.x.remote.gh-merge-base', false, false],
    ['branch.remote', false, false],
    // submodule.<name>.*
    ['submodule.libs/a.b.url', false, true],
    ['submodule.a.url.gitdir', false, false], // [submodule "a.url"] gitdir —— 有意未审计
    ['submodule.a.gitdir.url', false, true],
    // url.<base>.*
    ['url.https://github.com/.insteadof', false, true],
    ['url.git@a.b:.pushinsteadof', false, true],
    ['url.x.insteadof.y', false, false],
    // http.<url>.* / credential.<url>.*
    ['http.https://a.example/x.git.sslverify', false, true],
    ['http.https://a.example/x.clean', false, true],
    ['credential.https://a.example.helper', false, true],
    ['credential.x.uploadpack', false, true],
    // filter.<drv>.*
    ['filter.x.clean', true, false],
    ['filter.a.b.smudge', true, false],
    ['filter..clean', true, false], // [filter ""] clean + `* filter=`:git 会执行(real-git R52)
    ['filter..process', true, false],
    ['filter.a b.clean', true, false], // 驱动名里的 U+2028:正则的 `.` 不匹配它
    ['filter.a\rb.smudge', true, false],
    ['filter.x.clean.required', false, false], // [filter "x.clean"] required
    ['filter.clean', false, false],
    // diff.<drv>.*
    ['diff.a.b.textconv', true, false],
    ['diff..textconv', true, false],
    ['diff..command', true, false],
    ['diff.a b.command', true, false],
    ['diff.x.textconv.binary', false, true], // [diff "x.textconv"] binary
    ['diff.x.command.xfuncname', false, true],
    ['diff.external', true, false],
    ['diff.external.binary', false, true], // 名为 external 的驱动
    ['diff.x.external', false, false],
    // merge.<drv>.*
    ['merge.a.b.driver', true, false],
    ['merge..driver', true, false],
    ['merge.x.driver.name', false, true], // [merge "x.driver"] name
    ['merge.driver', false, false],
    // includeIf.<cond>.*
    ['includeif.gitdir:~/work/a.b/.path', false, true],
    ['includeif.onbranch:x.path.path', false, true],
    // pager.* / alias.*
    ['pager.diff', false, true],
    ['pager.a.b', false, false],
    ['alias.co', false, true],
    ['alias.a.b.command', false, true], // git >= 2.56
    ['alias.a.b', false, false],
    // guitool / difftool / mergetool
    ['guitool.a.b.cmd', false, true],
    ['difftool.a.b.cmd', false, true],
    ['difftool.x.cmd.path', false, true],
    ['mergetool.a.b.cmd', false, true],
    ['mergetool..path', false, true],
    // trailer.*
    ['trailer.a.b.command', true, false],
    ['trailer..cmd', true, false],
    ['trailer.x.command.key', false, true], // [trailer "x.command"] key
    ['trailer.x.cmd.ifexists', false, true],
    // hook.*:整段受限
    ['hook.jobs', true, false],
    ['hook.a.b.c.command', true, false],
    ['hook..command', true, false],
    ['hook.x.unknown-name', true, false],
    // gpg / protocol / lfs
    ['gpg.program', true, false],
    ['gpg.x509.program', true, false],
    ['gpg..program', true, false],
    ['gpg.ssh.defaultkeycommand', true, false],
    ['gpg.ssh.allowedsignersfile', false, true],
    ['protocol.a.b.allow', true, false],
    ['protocol..allow', true, false],
    ['protocol.allow', false, true],
    ['lfs.extension.a.b.clean', true, false],
    ['lfs.customtransfer.a.b.path', true, false],
    ['lfs.extension.clean', false, false],
  ];

  it.each(CASES)('C2 %j → restricted %s, reviewed %s', (key, restricted, reviewed) => {
    expect(classify(key)).toEqual({ key, restricted, reviewed });
    expect(classify(key.toUpperCase())).toEqual({ key: key.toUpperCase(), restricted, reviewed });
  });

  it('C3 the documented-key matcher uses the same split: a middle wildcard is the whole subsection (empty, dotted, any character), a trailing one is a variable name', () => {
    const m = parseConfigKeyList('filter.<driver>.clean\nalias.*\nhttp.<url>.*\nnotes.rewrite.<command>\ncolor.diff.commit\nlfs.extension.<name>.clean\n');
    for (const key of ['filter.x.clean', 'filter..clean', 'filter.a.b.clean', 'filter.a b.clean', 'filter.a\rb.clean', 'alias.x', 'http..x', 'http.a.b.c',
      'notes.rewrite.amend', 'color.diff.commit', 'Color.diff.Commit', 'lfs.extension.a.b.clean', 'lfs.extension..clean']) {
      expect({ key, known: m.matches(key) }).toEqual({ key, known: true });
    }
    for (const key of ['filter.clean', 'filter.x.clean.y', 'alias.x.y', 'http.x', 'notes.rewrite.a.b', 'notes.x.amend', 'color.diff.x.commit', 'color.commit',
      'lfs.extension.clean', 'lfs.other.x.clean', 'nodot', 'x.']) {
      expect({ key, known: m.matches(key) }).toEqual({ key, known: false });
    }
  });

  it('C4 end to end: an empty or odd driver name does not slip past the restricted list (and is not mistaken for a private key git ignores)', async () => {
    for (const key of ['filter..clean', 'filter.a b.clean', 'diff..textconv', 'merge..driver', 'remote..uploadpack', 'trailer..command']) {
      expect({ key, verdict: await verdictFor(key, 'evil') }).toMatchObject({ key, verdict: { kind: 'restricted', reason: 'unsafe-config', keys: [key] } });
    }
    for (const key of ['remote.a.uploadpack.url', 'branch.x.remote.merge', 'diff.x.textconv.binary', 'trailer.x.command.key']) {
      expect({ key, verdict: await verdictFor(key, 'v') }).toMatchObject({ key, verdict: { kind: 'trusted' } });
    }
  });

  it('C5 include / includeIf with any condition text (dots, empty, U+2028) keeps the verdict out of the cache', async () => {
    for (const key of ['include.path', 'includeif.gitdir:~/a.b/.path', 'includeif..path', 'includeif.onbranch:a b.path']) {
      expect({ key, verdict: await verdictFor(key, '../x.cfg') }).toMatchObject({ key, verdict: { kind: 'trusted', cacheable: false } });
    }
    expect(await verdictFor('branch.include.path.merge', 'x')).toMatchObject({ kind: 'trusted', cacheable: true });
  });

  it('C5b a key that cannot be split at all (git never prints one) is not waved through as a private key', async () => {
    for (const key of ['nodot', 'x.', '.x']) {
      expect({ key, verdict: await verdictFor(key, 'v') }).toMatchObject({ key, verdict: { kind: 'restricted', reason: 'unknown-config', keys: [key] } });
    }
  });
});

describe('overlap between the restricted rules and the reviewed table', () => {
  // 清单变了 → C6 变红 → 审查后更新 key-overlap.ts 里的快照。
  const allPatterns = [...new Set([...keyPatterns(HELP_2_50), ...keyPatterns(HELP_2_56), ...keyPatterns(KNOWN_SAFE_CONFIG_KEYS)])];

  it('C6 every documented key (git 2.50.1 and 2.56.1) and every table entry, instantiated with ordinary / dotted / empty / look-alike names: the keys both restricted and reviewed are exactly the reviewed snapshot', () => {
    expect(allPatterns.length).toBeGreaterThan(1000);
    expect(overlappingKeys(allPatterns)).toEqual(['core.bare', 'core.fsmonitor', 'diff.submodule']);
    expect(REVIEWED_OVERLAP).toEqual(['core.bare', 'core.fsmonitor', 'diff.submodule']);
  });

  it('C7 for each overlapping key the verdict does not depend on the table: an unsafe value restricts (unsafe-config), a safe value is trusted', async () => {
    const safeValue: Record<string, string> = { 'core.bare': 'false', 'core.fsmonitor': 'true', 'diff.submodule': 'log' };
    expect(Object.keys(safeValue)).toEqual(REVIEWED_OVERLAP);
    for (const key of REVIEWED_OVERLAP) {
      expect({ key, verdict: await verdictFor(key, '/x/evil') }).toMatchObject({ key, verdict: { kind: 'restricted', reason: 'unsafe-config', keys: [key] } });
      expect({ key, verdict: await verdictFor(key, safeValue[key]!) }).toMatchObject({ key, verdict: { kind: 'trusted' } });
    }
  });

  it('C8 no instantiation of a restricted documented key is ever reviewed: whatever the subsection looks like, a key git documents as executable cannot be waved through by a table wildcard', () => {
    // 文档里的受限键:具体化成普通名字时受限的那些模式
    const restrictedPatterns = allPatterns.filter((p) => {
      const plain = p.split('.').map((s) => (s === '*' || /^<.*>$/.test(s) ? 'x' : s)).join('.');
      return isUnsafeConfigEntry(local(plain)) && !REVIEWED_OVERLAP.includes(plain.toLowerCase());
    });
    expect(restrictedPatterns.length).toBeGreaterThanOrEqual(20);
    const wavedThrough = restrictedPatterns.flatMap(instantiations).filter((key) => isKnownSafeConfigKey(key) || !isUnsafeConfigEntry(local(key)));
    expect(wavedThrough).toEqual([]);
  });
});
