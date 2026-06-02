export function canCommit(message: string, stagedCount: number): boolean {
  if (message.trim() === '') return false;
  if (stagedCount === 0) return false;
  return true;
}

