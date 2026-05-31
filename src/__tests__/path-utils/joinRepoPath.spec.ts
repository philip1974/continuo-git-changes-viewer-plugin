import { describe, expect, it } from 'vitest';
import { joinRepoPath } from '../../git/path-utils';

describe('joinRepoPath', () => {
  it('T1 joins repo root with a relative path', () => {
    expect(joinRepoPath('/repo', 'src/a.ts')).toBe('/repo/src/a.ts');
  });

  it('T2 passes absolute paths through', () => {
    expect(joinRepoPath('/repo', '/tmp/a.ts')).toBe('/tmp/a.ts');
  });

  it('T3 tolerates trailing slash on repo root', () => {
    expect(joinRepoPath('/repo/', 'src/a.ts')).toBe('/repo/src/a.ts');
  });

  it('T4 tolerates a leading slash on relPath', () => {
    expect(joinRepoPath('/repo/', '/src/a.ts')).toBe('/src/a.ts');
  });
});

