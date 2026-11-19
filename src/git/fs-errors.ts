// 宿主 plugin-fs 错误经 ipcRenderer.invoke 传回时只剩 message(code 丢失),形如
// "Error invoking remote method 'plugin-fs:lstat': Error: ENOENT: no such file or directory, lstat '<path>'"。
// 只认 message 开头(可选 IPC 前缀之后紧跟)的 `ENOENT:`——路径(可被仓库所在目录名控制)总在末尾,
// 不能用"包含 ENOENT"判断,否则 `/x: ENOENT: …/repo` 这类目录名下的 scope 错误会被误判为不存在。
const NOT_FOUND_MESSAGE = /^(?:Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?)?ENOENT: /;

export function isNotFoundError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') {
    return true;
  }
  return err instanceof Error && NOT_FOUND_MESSAGE.test(err.message);
}
