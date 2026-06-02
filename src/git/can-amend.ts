export function canAmend(
  message: string,
  _stagedCount: number,
  hasHead: boolean,
): boolean {
  if (!hasHead) return false;
  if (message.trim() === '') return false;
  return true;
}

