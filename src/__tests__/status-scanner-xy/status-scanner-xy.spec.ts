import { describe, expect, it } from 'vitest';
import { parsePorcelainStatus } from '../../git/status-scanner';

describe('porcelain X/Y parsing', () => {
  it('T13 preserves staged, changed, partial, and untracked columns', () => {
    expect(parsePorcelainStatus('M  staged.ts\0 M changed.ts\0MM partial.ts\0?? notes.txt\0')).toEqual([
      { path: 'staged.ts', status: 'M', statusX: 'M', statusY: ' ', kind: 'text' },
      { path: 'changed.ts', status: 'M', statusX: ' ', statusY: 'M', kind: 'text' },
      { path: 'partial.ts', status: 'M', statusX: 'M', statusY: 'M', kind: 'text' },
      { path: 'notes.txt', status: 'U', statusX: '?', statusY: '?', kind: 'text' },
    ]);
  });

  it('T14 preserves rename oldPath and status columns', () => {
    expect(parsePorcelainStatus('R  src/new.ts\0src/old.ts\0')).toEqual([
      {
        path: 'src/new.ts',
        oldPath: 'src/old.ts',
        status: 'R',
        statusX: 'R',
        statusY: ' ',
        kind: 'text',
      },
    ]);
  });
});
