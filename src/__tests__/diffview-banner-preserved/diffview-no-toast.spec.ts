import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('DiffView contextual banner preservation', () => {
  it('T9 does not import or call the notifications SDK from DiffView', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/panel/DiffView.tsx'),
      'utf8',
    );

    expect(source).not.toContain('notifications');
    expect(source).not.toContain('notifications.show');
  });
});
