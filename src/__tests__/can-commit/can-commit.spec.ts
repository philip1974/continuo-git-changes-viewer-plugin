import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canCommit } from '../../git/can-commit';

describe('canCommit', () => {
  it('T11 returns false for an empty message', () => {
    expect(canCommit('', 1)).toBe(false);
  });

  it('T12 returns false for whitespace-only messages', () => {
    expect(canCommit(' \n\t ', 1)).toBe(false);
  });

  it('T13 returns false when no files are staged', () => {
    expect(canCommit('subject', 0)).toBe(false);
  });

  it('T14 returns true for a non-empty message with staged files', () => {
    expect(canCommit('subject', 2)).toBe(true);
  });

  it('T15 does not import git-store selectors', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../../git/can-commit.ts'), 'utf-8');

    expect(source).not.toContain('../state/git-store');
    expect(source).not.toContain('selectStaged');
  });
});

