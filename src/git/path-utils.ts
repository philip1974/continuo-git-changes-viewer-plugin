export function joinRepoPath(repoRoot: string, relPath: string): string {
  if (relPath.startsWith('/')) return relPath;
  return `${repoRoot.replace(/\/$/, '')}/${relPath.replace(/^\//, '')}`;
}
