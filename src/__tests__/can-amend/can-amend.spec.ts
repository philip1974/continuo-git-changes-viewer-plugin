import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canAmend } from '../../git/can-amend';

describe('canAmend', () => {
  it('T14 returns false when HEAD does not exist', () => {
    expect(canAmend('subject', 1, false)).toBe(false);
  });

  it('T15 returns false for an empty message even when files are staged', () => {
    expect(canAmend('', 1, true)).toBe(false);
  });

  it('T16 returns false for whitespace-only messages', () => {
    expect(canAmend(' \n\t ', 2, true)).toBe(false);
  });

  it('T17 returns true for message-only amend', () => {
    expect(canAmend('new subject', 0, true)).toBe(true);
  });

  it('T18 returns true for staged amend when the message is non-empty', () => {
    expect(canAmend('existing subject', 2, true)).toBe(true);
  });

  it('T19 does not import git-store selectors', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../../git/can-amend.ts'), 'utf-8');

    expect(source).not.toContain('../state/git-store');
    expect(source).not.toContain('selectStaged');
  });
});

