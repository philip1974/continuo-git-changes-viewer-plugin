// git 输出的路径(status / index)来自不可信仓库:伪造的 `.git/index` 可以包含 `../outside.txt`、
// 绝对路径、`.git/hooks/pre-commit` 这样的条目——git 读 index 时不校验,status 照样列出(实测 git 2.50);
// `git checkout -- .git/hooks/x` 甚至会把 index 里的 blob 写进 git 目录。插件只接受"规范的仓库内相对路径"。

// HFS+ 会忽略的 Unicode 码位(git 的 is_hfs_dotgit 同款):`.g‌it` 在 macOS 上就是 `.git`。
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/** 段名在 HFS+ / NTFS 上会被解析成 `.git`(大小写、可忽略码位、结尾的点与空格、`:流`、8.3 短名)。 */
function isDotGitSegment(segment: string): boolean {
  const name = segment
    .replace(HFS_IGNORABLE, '')
    .replace(/:.*$/, '')
    .replace(/[. ]+$/, '')
    .toLowerCase();
  return name === '.git' || name === 'git~1';
}

/**
 * 规范的仓库内相对路径:非空、非绝对(POSIX `/`、Windows `\`、盘符)、不含空段 / `.` / `..` 段
 * (允许结尾一个 `/`:status 把未跟踪目录写成 `dir/`)、任何一段都不是 `.git`。
 * `\` 也当分隔符检查(Windows 上它就是),代价是 POSIX 上名字形如 `..\x` 的文件不被接受。
 * 含 U+FFFD 的名字也不接受:宿主把 git 的输出按 UTF-8 解码,不是合法 UTF-8 的文件名字节(index 里可以有;
 * Linux 上磁盘上也可以有,如 Latin-1 名字)变成 U+FFFD,原来的字节已经丢了——把这个字符串当参数传回 git,
 * 指的是另一个路径(名字里确实是 U+FFFD 字符的那个文件,如果存在的话;实测 real-git R76)。无法区分"原本就是
 * U+FFFD",两者一律不接受(保守)。
 */
export function isSafeRepoRelativePath(path: string): boolean {
  if (path === '' || path.includes('\0') || path.includes('\uFFFD')) return false;
  if (/^[\\/]/.test(path) || /^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split(/[\\/]/);
  if (segments[segments.length - 1] === '') segments.pop();
  if (segments.length === 0) return false;
  return segments.every((s) => s !== '' && s !== '.' && s !== '..' && !isDotGitSegment(s));
}

/**
 * git 自己绝不会写进 index 的路径:POSIX 绝对路径、含空段 / `.` / `..` 段、任何一段是 `.git`
 * (git 的 verify_path 在写 index 时拒绝它们;读 index 时不校验)。status 里出现这样的条目说明 index 是
 * 伪造的。只按 `/` 分段、不看盘符:`c:notes.txt`、`..\x` 在 POSIX 上是合法文件名,它们仍不满足
 * isSafeRepoRelativePath(列表里显示为不可操作行,见 status-scanner 的 FileChange.inoperable;路径不进入
 * 任何 git / cat 参数),但不构成"伪造"的证据。
 */
export function isForgedIndexPath(path: string): boolean {
  if (path === '') return false;
  if (path.startsWith('/')) return true;
  const segments = path.split('/');
  if (segments[segments.length - 1] === '') segments.pop();
  return segments.some((s) => s === '' || s === '.' || s === '..' || isDotGitSegment(s));
}

/** 仓库内相对路径 → 绝对路径;不是规范的仓库内相对路径时返回 null(调用方不得使用)。 */
export function joinRepoPath(repoRoot: string, relPath: string): string | null {
  if (!isSafeRepoRelativePath(relPath)) return null;
  return `${repoRoot.replace(/[\\/]+$/, '')}/${relPath}`;
}

export const UNSAFE_PATH_ERROR = 'Refusing to run git on a path that is not inside this repository';
